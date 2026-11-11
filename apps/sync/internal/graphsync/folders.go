package graphsync

import (
	"context"

	"tresso/sync/internal/api"
	"tresso/sync/internal/ingestmsg"
)

// Roles of Outlook's well-known folders.
var wellKnownRoles = []struct{ name, role string }{
	{"inbox", "inbox"},
	{"sentitems", "sent"},
	{"drafts", "drafts"},
	{"deleteditems", "trash"},
	{"junkemail", "spam"},
	{"archive", "archive"},
}

// listFolders returns the whole folder tree. The remote name is the folder id; nested folders show their path. A
// folder whose children Graph refuses to list (403, a folder the user lost access to) is listed without them; denied
// names those folders.
func listFolders(ctx context.Context, c *Client) (folders []api.Folder, denied []string, err error) {
	roleOf := map[string]string{}
	for _, wk := range wellKnownRoles {
		id, err := c.wellKnownID(ctx, wk.name)
		if err != nil {
			return nil, nil, err
		}
		if id != "" {
			roleOf[id] = wk.role
		}
	}

	var walk func(parentID, prefix string) error
	walk = func(parentID, prefix string) error {
		level, err := c.folders(ctx, parentID)
		if parentID != "" && accessDenied(err) {
			denied = append(denied, prefix)
			return nil
		}
		if err != nil {
			return err
		}
		for _, f := range level {
			path := f.DisplayName
			if prefix != "" {
				path = prefix + "/" + f.DisplayName
			}
			role := roleOf[f.ID]
			if role == "" {
				role = "custom"
			}
			folders = append(folders, api.Folder{RemoteName: f.ID, DisplayName: ingestmsg.Truncate(path, 255), Role: role})
			if f.ChildFolderCount > 0 {
				if err := walk(f.ID, path); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := walk("", ""); err != nil {
		return nil, nil, err
	}

	// Inbox first: it is what users look at, so it syncs first.
	for i, f := range folders {
		if f.Role == "inbox" && i > 0 {
			inbox := folders[i]
			copy(folders[1:i+1], folders[:i])
			folders[0] = inbox
			break
		}
	}
	return folders, denied, nil
}
