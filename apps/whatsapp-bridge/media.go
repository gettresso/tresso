package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waMmsRetry"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

// Downloads: POST /api/download ends here. A file goes to <store>/<chat>/<message id>_<name>, readable by this user
// only.

// DownloadMediaRequest represents the request body for the download media API
type DownloadMediaRequest struct {
	MessageID string `json:"message_id"`
	ChatJID   string `json:"chat_jid"`
}

// DownloadMediaResponse represents the response for the download media API
type DownloadMediaResponse struct {
	Success  bool   `json:"success"`
	Message  string `json:"message"`
	Filename string `json:"filename,omitempty"`
	Path     string `json:"path,omitempty"`
}

// MediaDownloader implements the whatsmeow.DownloadableMessage interface
type MediaDownloader struct {
	URL           string
	DirectPath    string
	MediaKey      []byte
	FileLength    uint64
	FileSHA256    []byte
	FileEncSHA256 []byte
	MediaType     whatsmeow.MediaType
}

// GetDirectPath implements the DownloadableMessage interface
func (d *MediaDownloader) GetDirectPath() string {
	return d.DirectPath
}

// GetURL implements the DownloadableMessage interface
func (d *MediaDownloader) GetURL() string {
	return d.URL
}

// GetMediaKey implements the DownloadableMessage interface
func (d *MediaDownloader) GetMediaKey() []byte {
	return d.MediaKey
}

// GetFileLength implements the DownloadableMessage interface
func (d *MediaDownloader) GetFileLength() uint64 {
	return d.FileLength
}

// GetFileSHA256 implements the DownloadableMessage interface
func (d *MediaDownloader) GetFileSHA256() []byte {
	return d.FileSHA256
}

// GetFileEncSHA256 implements the DownloadableMessage interface
func (d *MediaDownloader) GetFileEncSHA256() []byte {
	return d.FileEncSHA256
}

// GetMediaType implements the DownloadableMessage interface
func (d *MediaDownloader) GetMediaType() whatsmeow.MediaType {
	return d.MediaType
}

// Function to download media from a message
func downloadMedia(ctx context.Context, client *whatsmeow.Client, messageStore *MessageStore, messageID, chatJID string) (bool, string, string, string, error) {
	// Query the database for the message
	var mediaType, filename, url string
	var mediaKey, fileSHA256, fileEncSHA256 []byte
	var fileLength uint64
	var err error

	// The chat JID becomes a folder name and the message ID part of a file name: neither may name another place.
	if err := validChatJID(chatJID); err != nil {
		return false, "", "", "", err
	}
	if !validMessageID(messageID) {
		return false, "", "", "", fmt.Errorf("invalid message ID")
	}

	// The chat folder sits directly in the store folder, whatever the working directory.
	chatDir := filepath.Join(messageStore.dir, strings.ReplaceAll(chatJID, ":", "_"))
	localPath := ""

	// Get media info from the database
	mediaType, filename, url, mediaKey, fileSHA256, fileEncSHA256, fileLength, err = messageStore.GetMediaInfo(messageID, chatJID)

	if err != nil {
		// Try to get basic info if extended info isn't available
		err = messageStore.db.QueryRow(
			"SELECT media_type, filename FROM messages WHERE id = ? AND chat_jid = ?",
			messageID, chatJID,
		).Scan(&mediaType, &filename)

		if err != nil {
			return false, "", "", "", fmt.Errorf("failed to find message: %v", err)
		}
	}

	// Check if this is a media message
	if mediaType == "" {
		return false, "", "", "", fmt.Errorf("not a media message")
	}

	// A document's name comes from whoever sent it: keep only its last part, so the file cannot be written outside
	// the chat's folder (a name such as ../../Library/LaunchAgents/x.plist).
	filename = filepath.Base(filename)
	if filename == "." || filename == ".." || filename == string(filepath.Separator) {
		return false, "", "", "", fmt.Errorf("invalid file name")
	}

	// Create directory for the chat if it doesn't exist
	if err := os.MkdirAll(chatDir, 0700); err != nil {
		return false, "", "", "", fmt.Errorf("failed to create chat directory: %v", err)
	}

	// The file is named after its message as well, so two files with one name in a chat never share a path.
	localPath = filepath.Join(chatDir, mediaFileName(messageID, filename))

	// The store folder is an absolute path (readConfig refuses anything else), so localPath is one as well: the path
	// the caller gets back.
	absPath := localPath

	// A file downloaded before is used again only when it is still the file the message names.
	if storedFileMatches(localPath, fileSHA256) {
		return true, mediaType, filename, absPath, nil
	}

	// If we don't have all the media info we need, we can't download
	if url == "" || len(mediaKey) == 0 || len(fileSHA256) == 0 || len(fileEncSHA256) == 0 || fileLength == 0 {
		return false, "", "", "", fmt.Errorf("incomplete media information for download")
	}

	// Extract direct path from URL
	directPath := extractDirectPathFromURL(url)

	// Create a downloader that implements DownloadableMessage
	var waMediaType whatsmeow.MediaType
	switch mediaType {
	case "image":
		waMediaType = whatsmeow.MediaImage
	case "video":
		waMediaType = whatsmeow.MediaVideo
	case "audio":
		waMediaType = whatsmeow.MediaAudio
	case "document":
		waMediaType = whatsmeow.MediaDocument
	default:
		return false, "", "", "", fmt.Errorf("unsupported media type: %s", mediaType)
	}

	downloader := &MediaDownloader{
		URL:           url,
		DirectPath:    directPath,
		MediaKey:      mediaKey,
		FileLength:    fileLength,
		FileSHA256:    fileSHA256,
		FileEncSHA256: fileEncSHA256,
		MediaType:     waMediaType,
	}

	// Download the media using whatsmeow client
	mediaData, err := client.Download(ctx, downloader)
	if isExpiredMediaError(err) {
		// The stored link has expired: ask the sender's phone to upload the file again.
		newPath, retryErr := requestMediaReupload(ctx, client, messageStore, messageID, chatJID, mediaKey)
		if retryErr != nil {
			return false, "", "", "", fmt.Errorf("failed to download media: %v; re-upload failed: %v", err, retryErr)
		}
		downloader.DirectPath = newPath
		mediaData, err = client.Download(ctx, downloader)
	}
	if err != nil {
		return false, "", "", "", fmt.Errorf("failed to download media: %v", err)
	}

	// Save the downloaded media to file
	if err := writePrivateFile(localPath, mediaData); err != nil {
		return false, "", "", "", fmt.Errorf("failed to save media file: %v", err)
	}

	return true, mediaType, filename, absPath, nil
}

// chatServers are the servers a chat JID may name: a person (phone number or LID), a group, a channel.
var chatServers = map[string]bool{
	types.DefaultUserServer: true,
	types.GroupServer:       true,
	types.HiddenUserServer:  true,
	types.NewsletterServer:  true,
}

// validChatJID accepts a chat JID that is safe to use as a folder name: one user part without path separators on one
// of chatServers.
func validChatJID(chatJID string) error {
	if strings.ContainsAny(chatJID, "/\\\x00") || strings.Count(chatJID, "@") != 1 {
		return fmt.Errorf("invalid chat JID")
	}
	jid, err := types.ParseJID(chatJID)
	if err != nil || jid.User == "" || !chatServers[jid.Server] {
		return fmt.Errorf("invalid chat JID")
	}
	return nil
}

// validMessageID accepts the message IDs WhatsApp gives out: letters, digits, '-' and '_'.
func validMessageID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// maxDocumentNameBytes is the most of a document's name that goes into a stored file name.
const maxDocumentNameBytes = 200

// maxFileNameBytes is the longest file name the file systems the bridge runs on accept.
const maxFileNameBytes = 255

// mediaFileName is the name a download is stored under: the message ID and the last part of the name the message
// gives, so two messages never share a file. The document's name is cut so the whole stays within maxFileNameBytes.
func mediaFileName(messageID, filename string) string {
	limit := maxFileNameBytes - len(messageID) - 1
	if limit > maxDocumentNameBytes {
		limit = maxDocumentNameBytes
	}
	return messageID + "_" + shortenFileName(filename, limit)
}

// shortenFileName cuts name to at most limit bytes on a rune boundary, keeping its extension when the extension
// leaves room for some of the name before it.
func shortenFileName(name string, limit int) string {
	if len(name) <= limit {
		return name
	}
	ext := filepath.Ext(name)
	if len(ext) >= limit/2 {
		ext = ""
	}
	return cutAtRune(strings.TrimSuffix(name, ext), limit-len(ext)) + ext
}

// cutAtRune returns the longest prefix of s of at most n bytes that does not end inside a UTF-8 sequence.
func cutAtRune(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// storedFileMatches reports whether path holds a file whose SHA-256 is the one the message names. Without a stored
// hash there is nothing to compare, and the file is downloaded again.
func storedFileMatches(path string, wantSHA256 []byte) bool {
	if len(wantSHA256) != sha256.Size {
		return false
	}
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return false
	}
	return bytes.Equal(hash.Sum(nil), wantSHA256)
}

// writePrivateFile writes data to path readable by this user only. It writes a temporary file next to it first, so
// a reader never sees half a file and two downloads of one message never write into one file.
func writePrivateFile(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".download-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return err
	}
	return nil
}

// mediaRetryTimeout is how long we wait for the phone to answer a re-upload request.
const mediaRetryTimeout = 60 * time.Second

var (
	mediaRetryMu      sync.Mutex
	mediaRetryWaiters = map[types.MessageID]chan *events.MediaRetry{}
)

// isExpiredMediaError reports whether a download failed because WhatsApp no longer serves the stored link.
func isExpiredMediaError(err error) bool {
	return errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith403) ||
		errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith404) ||
		errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith410)
}

// errMediaRetryPending refuses a second re-upload request for a message while the first still waits: both would
// wait on one answer from the phone, and the first to finish would remove the other's waiter.
var errMediaRetryPending = errors.New("a re-upload of this message is already being requested")

// registerMediaRetryWaiter makes the waiter that receives the phone's answer for messageID.
func registerMediaRetryWaiter(messageID types.MessageID) (chan *events.MediaRetry, error) {
	mediaRetryMu.Lock()
	defer mediaRetryMu.Unlock()
	if _, waiting := mediaRetryWaiters[messageID]; waiting {
		return nil, errMediaRetryPending
	}
	waiter := make(chan *events.MediaRetry, 1)
	mediaRetryWaiters[messageID] = waiter
	return waiter, nil
}

// releaseMediaRetryWaiter removes the waiter for messageID, but only when it is still this one.
func releaseMediaRetryWaiter(messageID types.MessageID, waiter chan *events.MediaRetry) {
	mediaRetryMu.Lock()
	defer mediaRetryMu.Unlock()
	if mediaRetryWaiters[messageID] == waiter {
		delete(mediaRetryWaiters, messageID)
	}
}

// handleMediaRetry hands a phone's answer to the download that is waiting for it.
func handleMediaRetry(evt *events.MediaRetry) {
	mediaRetryMu.Lock()
	waiter, ok := mediaRetryWaiters[evt.MessageID]
	mediaRetryMu.Unlock()
	if !ok {
		return
	}
	select {
	case waiter <- evt:
	default:
	}
}

// lidLookup is the part of whatsmeow's LID store that senderJID asks (client.Store.LIDs).
type lidLookup interface {
	GetPNForLID(ctx context.Context, lid types.JID) (types.JID, error)
	GetLIDForPN(ctx context.Context, pn types.JID) (types.JID, error)
}

// senderJID rebuilds the sender's JID from the stored user part. The store keeps only the user part, which is a
// phone number or a LID. whatsmeow's LID map says which one it is: a user part it maps as a LID is one, a user part it
// maps as a phone number is one. Only when the map knows neither (or cannot be read) does the length decide: LIDs
// are longer than the phone numbers in use, though E.164 allows up to 15 digits.
func senderJID(ctx context.Context, lids lidLookup, sender string) (types.JID, error) {
	if strings.Contains(sender, "@") {
		return types.ParseJID(sender)
	}
	if sender == "" {
		return types.JID{}, fmt.Errorf("message has no sender")
	}
	lid := types.NewJID(sender, types.HiddenUserServer)
	pn := types.NewJID(sender, types.DefaultUserServer)
	if lids != nil {
		if found, err := lids.GetPNForLID(ctx, lid); err == nil && !found.IsEmpty() {
			return lid, nil
		}
		if found, err := lids.GetLIDForPN(ctx, pn); err == nil && !found.IsEmpty() {
			return pn, nil
		}
	}
	if len(sender) > 13 {
		return lid, nil
	}
	return pn, nil
}

// requestMediaReupload asks the sender's phone to upload expired media again and returns
// the new direct path. The phone must be online and still have the file.
func requestMediaReupload(ctx context.Context, client *whatsmeow.Client, messageStore *MessageStore, messageID, chatJID string, mediaKey []byte) (string, error) {
	var sender string
	var isFromMe bool
	if err := messageStore.db.QueryRow(
		"SELECT sender, is_from_me FROM messages WHERE id = ? AND chat_jid = ?",
		messageID, chatJID,
	).Scan(&sender, &isFromMe); err != nil {
		return "", fmt.Errorf("failed to load message sender: %v", err)
	}

	chat, err := types.ParseJID(chatJID)
	if err != nil {
		return "", fmt.Errorf("invalid chat JID: %v", err)
	}
	info := &types.MessageInfo{
		ID: messageID,
		MessageSource: types.MessageSource{
			Chat:     chat,
			IsFromMe: isFromMe,
			IsGroup:  chat.Server == types.GroupServer,
		},
	}
	if info.IsGroup {
		if info.Sender, err = senderJID(ctx, client.Store.LIDs, sender); err != nil {
			return "", err
		}
	}

	waiter, err := registerMediaRetryWaiter(messageID)
	if err != nil {
		return "", err
	}
	defer releaseMediaRetryWaiter(messageID, waiter)

	if err := client.SendMediaRetryReceipt(ctx, info, mediaKey); err != nil {
		return "", fmt.Errorf("failed to send re-upload request: %v", err)
	}

	evt, err := awaitMediaRetry(ctx, waiter, mediaRetryTimeout)
	if err != nil {
		return "", err
	}
	notif, err := whatsmeow.DecryptMediaRetryNotification(evt, mediaKey)
	if err != nil {
		return "", fmt.Errorf("failed to read the phone's answer: %v", err)
	}
	if notif.GetResult() != waMmsRetry.MediaRetryNotification_SUCCESS || notif.GetDirectPath() == "" {
		return "", fmt.Errorf("phone could not re-upload the media: %s", notif.GetResult())
	}
	return notif.GetDirectPath(), nil
}

// awaitMediaRetry waits for the phone's answer, at most timeout, and stops as soon as ctx ends (the client that
// asked for the download went away).
func awaitMediaRetry(ctx context.Context, waiter <-chan *events.MediaRetry, timeout time.Duration) (*events.MediaRetry, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case evt := <-waiter:
		return evt, nil
	case <-timer.C:
		return nil, fmt.Errorf("no answer from the phone within %s", timeout)
	case <-ctx.Done():
		return nil, fmt.Errorf("stopped waiting for the phone: %v", ctx.Err())
	}
}

// Extract direct path from a WhatsApp media URL
func extractDirectPathFromURL(url string) string {
	// The direct path is typically in the URL, we need to extract it
	// Example URL: https://mmg.whatsapp.net/v/t62.7118-24/13812002_698058036224062_3424455886509161511_n.enc?ccb=11-4&oh=...

	// Find the path part after the domain
	parts := strings.SplitN(url, ".net/", 2)
	if len(parts) < 2 {
		return url // Return original URL if parsing fails
	}

	pathPart := parts[1]

	// Remove query parameters
	pathPart = strings.SplitN(pathPart, "?", 2)[0]

	// Create proper direct path format
	return "/" + pathPart
}
