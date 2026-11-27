package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"go.mau.fi/whatsmeow"
	waProto "go.mau.fi/whatsmeow/binary/proto"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

// Sending: POST /api/send ends here. The answer goes back to the caller over HTTP only, never to stdout or stderr.

// SendMessageResponse represents the response for the send message API
type SendMessageResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

// SendMessageRequest represents the request body for the send message API
type SendMessageRequest struct {
	Recipient string `json:"recipient"`
	Message   string `json:"message"`
	MediaPath string `json:"media_path,omitempty"`
}

// maxSendBytes is the largest file the bridge sends: the desktop app's MAX_SEND_BYTES (100 MB), so a file it allows is
// never refused here.
const maxSendBytes = 100 * 1024 * 1024

var (
	errMediaNotAbsolute = errors.New("media path must be absolute")
	errMediaNotFile     = errors.New("media path is not a regular file")
	errMediaTooLarge    = errors.New("media file is larger than 100 MB")
	errMediaUnreadable  = errors.New("media file cannot be read")
	errRecipient        = errors.New("recipient is not a phone number or a person, group or LID JID")
)

// recipientServers are the servers a recipient JID may name: a person, a group, a person by LID. The same as the
// desktop app's valid_jid.
var recipientServers = map[string]bool{
	types.DefaultUserServer: true,
	types.GroupServer:       true,
	types.HiddenUserServer:  true,
}

// recipientJID reads a recipient as the desktop app sends it (valid_recipient in whatsapp.rs): a phone number of 1 to
// 32 digits, or a JID `<user>@<server>` whose user is 1 to 128 of [0-9A-Za-z.:_-] and whose server is
// s.whatsapp.net, g.us or lid. Anything else (status@broadcast, a channel, a free string) is refused.
func recipientJID(recipient string) (types.JID, error) {
	if recipient != "" && len(recipient) <= 32 && allDigits(recipient) {
		return types.JID{User: recipient, Server: types.DefaultUserServer}, nil
	}
	user, server, found := strings.Cut(recipient, "@")
	if !found || !recipientServers[server] || user == "" || len(user) > 128 {
		return types.JID{}, errRecipient
	}
	for _, c := range user {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '.' || c == ':' || c == '_' || c == '-') {
			return types.JID{}, errRecipient
		}
	}
	jid, err := types.ParseJID(recipient)
	if err != nil || jid.User == "" || !recipientServers[jid.Server] {
		return types.JID{}, errRecipient
	}
	return jid, nil
}

func allDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// checkMedia refuses a media path the bridge must not read: not absolute, not a regular file once links are followed
// (a FIFO or a device would block or never end), or larger than maxSendBytes. The desktop app sends a canonical path.
func checkMedia(path string) error {
	if !filepath.IsAbs(path) {
		return errMediaNotAbsolute
	}
	info, err := os.Stat(path)
	if err != nil {
		return errMediaUnreadable
	}
	if !info.Mode().IsRegular() {
		return errMediaNotFile
	}
	if info.Size() > maxSendBytes {
		return errMediaTooLarge
	}
	return nil
}

// readMedia reads a file checkMedia accepts. It opens without blocking (the path may have become a FIFO since the
// check), checks the open file again and reads at most maxSendBytes, so it never waits on a pipe or fills memory.
func readMedia(path string) ([]byte, error) {
	if err := checkMedia(path); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, errMediaUnreadable
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, errMediaUnreadable
	}
	if !info.Mode().IsRegular() {
		return nil, errMediaNotFile
	}
	if info.Size() > maxSendBytes {
		return nil, errMediaTooLarge
	}
	data, err := io.ReadAll(io.LimitReader(file, maxSendBytes+1))
	if err != nil {
		return nil, errMediaUnreadable
	}
	if len(data) > maxSendBytes {
		return nil, errMediaTooLarge
	}
	return data, nil
}

// Function to send a WhatsApp message
func sendWhatsAppMessage(client *whatsmeow.Client, recipient string, message string, mediaPath string) (bool, string) {
	if !client.IsConnected() {
		return false, "Not connected to WhatsApp"
	}

	// The handler checked the recipient already; this keeps the function safe on its own.
	to, err := recipientJID(recipient)
	if err != nil {
		return false, err.Error()
	}

	msg := &waProto.Message{}

	// Check if we have media to send
	if mediaPath != "" {
		// Read media file: a regular file of at most maxSendBytes, never a FIFO or a device.
		mediaData, err := readMedia(mediaPath)
		if err != nil {
			return false, fmt.Sprintf("Error reading media file: %v", err)
		}

		// Determine media type and mime type based on file extension
		fileExt := strings.ToLower(mediaPath[strings.LastIndex(mediaPath, ".")+1:])
		var mediaType whatsmeow.MediaType
		var mimeType string

		// Handle different media types
		switch fileExt {
		// Image types
		case "jpg", "jpeg":
			mediaType = whatsmeow.MediaImage
			mimeType = "image/jpeg"
		case "png":
			mediaType = whatsmeow.MediaImage
			mimeType = "image/png"
		case "gif":
			mediaType = whatsmeow.MediaImage
			mimeType = "image/gif"
		case "webp":
			mediaType = whatsmeow.MediaImage
			mimeType = "image/webp"

		// Audio types
		case "ogg":
			mediaType = whatsmeow.MediaAudio
			mimeType = "audio/ogg; codecs=opus"

		// Video types
		case "mp4":
			mediaType = whatsmeow.MediaVideo
			mimeType = "video/mp4"
		case "avi":
			mediaType = whatsmeow.MediaVideo
			mimeType = "video/avi"
		case "mov":
			mediaType = whatsmeow.MediaVideo
			mimeType = "video/quicktime"

		// Document types (for any other file type)
		default:
			mediaType = whatsmeow.MediaDocument
			mimeType = "application/octet-stream"
		}

		// Upload media to WhatsApp servers
		resp, err := client.Upload(context.Background(), mediaData, mediaType)
		if err != nil {
			return false, fmt.Sprintf("Error uploading media: %v", err)
		}

		// Create the appropriate message type based on media type
		switch mediaType {
		case whatsmeow.MediaImage:
			msg.ImageMessage = &waProto.ImageMessage{
				Caption:       proto.String(message),
				Mimetype:      proto.String(mimeType),
				URL:           &resp.URL,
				DirectPath:    &resp.DirectPath,
				MediaKey:      resp.MediaKey,
				FileEncSHA256: resp.FileEncSHA256,
				FileSHA256:    resp.FileSHA256,
				FileLength:    &resp.FileLength,
			}
		case whatsmeow.MediaAudio:
			// Handle ogg audio files
			var seconds uint32 = 30 // Default fallback
			var waveform []byte = nil

			// Try to analyze the ogg file
			if strings.Contains(mimeType, "ogg") {
				analyzedSeconds, analyzedWaveform, err := analyzeOggOpus(mediaData)
				if err == nil {
					seconds = analyzedSeconds
					waveform = analyzedWaveform
				} else {
					return false, fmt.Sprintf("Failed to analyze Ogg Opus file: %v", err)
				}
			}

			msg.AudioMessage = &waProto.AudioMessage{
				Mimetype:      proto.String(mimeType),
				URL:           &resp.URL,
				DirectPath:    &resp.DirectPath,
				MediaKey:      resp.MediaKey,
				FileEncSHA256: resp.FileEncSHA256,
				FileSHA256:    resp.FileSHA256,
				FileLength:    &resp.FileLength,
				Seconds:       proto.Uint32(seconds),
				PTT:           proto.Bool(true),
				Waveform:      waveform,
			}
		case whatsmeow.MediaVideo:
			msg.VideoMessage = &waProto.VideoMessage{
				Caption:       proto.String(message),
				Mimetype:      proto.String(mimeType),
				URL:           &resp.URL,
				DirectPath:    &resp.DirectPath,
				MediaKey:      resp.MediaKey,
				FileEncSHA256: resp.FileEncSHA256,
				FileSHA256:    resp.FileSHA256,
				FileLength:    &resp.FileLength,
			}
		case whatsmeow.MediaDocument:
			msg.DocumentMessage = &waProto.DocumentMessage{
				Title:         proto.String(mediaPath[strings.LastIndex(mediaPath, "/")+1:]),
				Caption:       proto.String(message),
				Mimetype:      proto.String(mimeType),
				URL:           &resp.URL,
				DirectPath:    &resp.DirectPath,
				MediaKey:      resp.MediaKey,
				FileEncSHA256: resp.FileEncSHA256,
				FileSHA256:    resp.FileSHA256,
				FileLength:    &resp.FileLength,
			}
		}
	} else {
		msg.Conversation = proto.String(message)
	}

	// Send message
	_, err = client.SendMessage(context.Background(), to, msg)

	if err != nil {
		return false, fmt.Sprintf("Error sending message: %v", err)
	}

	return true, fmt.Sprintf("Message sent to %s", recipient)
}

// opusGranuleRate is the rate of an Opus granule position: 48 kHz, whatever the input sample rate.
const opusGranuleRate = 48000.0

// maxVoiceSeconds is the longest duration a voice message is given.
const maxVoiceSeconds = 300

// analyzeOggOpus tries to extract duration and generate a simple waveform from an Ogg Opus file
func analyzeOggOpus(data []byte) (duration uint32, waveform []byte, err error) {
	// Try to detect if this is a valid Ogg file by checking for the "OggS" signature
	// at the beginning of the file
	if len(data) < 4 || string(data[0:4]) != "OggS" {
		return 0, nil, fmt.Errorf("not a valid Ogg file (missing OggS signature)")
	}

	// Parse Ogg pages to find the last page with a valid granule position. Every read below stays inside data: the
	// file comes from the caller and may be cut short or malformed anywhere.
	var lastGranule uint64
	var preSkip uint16
	var foundOpusHead bool

	// Scan through the file looking for Ogg pages
	for i := 0; i < len(data); {
		// Check if we have enough data to read Ogg page header
		if i+27 > len(data) {
			break
		}

		// Verify Ogg page signature
		if string(data[i:i+4]) != "OggS" {
			// Skip until next potential page
			i++
			continue
		}

		// Extract header fields
		granulePos := binary.LittleEndian.Uint64(data[i+6 : i+14])
		pageSeqNum := binary.LittleEndian.Uint32(data[i+18 : i+22])
		numSegments := int(data[i+26])

		// Extract segment table
		if i+27+numSegments > len(data) {
			break
		}
		segmentTable := data[i+27 : i+27+numSegments]

		// Calculate page size
		pageSize := 27 + numSegments
		for _, segLen := range segmentTable {
			pageSize += int(segLen)
		}
		// A page that claims more bytes than the file has left is cut off: stop here.
		if i+pageSize > len(data) {
			break
		}

		// Check if we're looking at an OpusHead packet (should be in first few pages)
		if !foundOpusHead && pageSeqNum <= 1 {
			// OpusHead: magic "OpusHead" (8 bytes), version (1), channels (1), pre-skip (2, at offset 10), input
			// sample rate (4, at offset 12), ...
			pageData := data[i : i+pageSize]
			headPos := bytes.Index(pageData, []byte("OpusHead"))
			if headPos >= 0 && headPos+16 <= len(pageData) {
				preSkip = binary.LittleEndian.Uint16(pageData[headPos+10 : headPos+12])
				foundOpusHead = true
			}
		}

		// Keep track of last valid granule position
		if granulePos != 0 {
			lastGranule = granulePos
		}

		// Move to next page
		i += pageSize
	}

	// Calculate duration based on granule position. An Opus granule position counts samples at 48 kHz whatever the
	// input sample rate in the head was.
	if lastGranule > uint64(preSkip) {
		durationSeconds := float64(lastGranule-uint64(preSkip)) / opusGranuleRate
		duration = uint32(math.Min(math.Ceil(durationSeconds), maxVoiceSeconds))
	} else {
		// Fallback to rough estimation if granule position not found
		durationEstimate := float64(len(data)) / 2000.0 // Very rough approximation
		duration = uint32(math.Min(durationEstimate, maxVoiceSeconds))
	}

	// Make sure we have a reasonable duration (at least 1 second, at most 300 seconds)
	if duration < 1 {
		duration = 1
	} else if duration > 300 {
		duration = 300
	}

	// Generate waveform
	waveform = placeholderWaveform(duration)

	return duration, waveform, nil
}

// placeholderWaveform generates a synthetic waveform for WhatsApp voice messages
// that appears natural with some variability based on the duration
func placeholderWaveform(duration uint32) []byte {
	// WhatsApp expects a 64-byte waveform for voice messages
	const waveformLength = 64
	waveform := make([]byte, waveformLength)

	// A generator seeded with the duration, so one duration always gets the same waveform. (The global rand.Seed the
	// fork called has done nothing since Go 1.24.)
	random := rand.New(rand.NewSource(int64(duration)))

	// Create a more natural looking waveform with some patterns and variability
	// rather than completely random values

	// Base amplitude and frequency - longer messages get faster frequency
	baseAmplitude := 35.0
	frequencyFactor := float64(min(int(duration), 120)) / 30.0

	for i := range waveform {
		// Position in the waveform (normalized 0-1)
		pos := float64(i) / float64(waveformLength)

		// Create a wave pattern with some randomness
		// Use multiple sine waves of different frequencies for more natural look
		val := baseAmplitude * math.Sin(pos*math.Pi*frequencyFactor*8)
		val += (baseAmplitude / 2) * math.Sin(pos*math.Pi*frequencyFactor*16)

		// Add some randomness to make it look more natural
		val += (random.Float64() - 0.5) * 15

		// Add some fade-in and fade-out effects
		fadeInOut := math.Sin(pos * math.Pi)
		val = val * (0.7 + 0.3*fadeInOut)

		// Center around 50 (typical voice baseline)
		val = val + 50

		// Ensure values stay within WhatsApp's expected range (0-100)
		if val < 0 {
			val = 0
		} else if val > 100 {
			val = 100
		}

		waveform[i] = byte(val)
	}

	return waveform
}
