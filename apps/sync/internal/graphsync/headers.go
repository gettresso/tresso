package graphsync

import (
	"context"
	"strings"
)

// internetHeadersSet is the property set Exchange keeps a message's custom internet headers (X-...) in.
const internetHeadersSet = "{00020386-0000-0000-C000-000000000046}"

// findByHeader goes through all of a folder's messages that filter selects (a time window; "" for all) and returns
// the ids of those whose custom header name has value. Graph exposes the header two ways and both are read: the
// message's internetMessageHeaders, and the named property Exchange stores an X- header of a MIME message in. Only
// those fields are asked for, a thousand messages a page, so a busy window costs a page per thousand messages.
func (c *Client) findByHeader(ctx context.Context, folder, filter, name, value string) ([]string, error) {
	property := "String " + internetHeadersSet + " Name " + name
	link := "/me/mailFolders/" + folder + "/messages?$select=id,internetMessageHeaders&$top=1000" +
		"&$expand=" + queryEscape("singleValueExtendedProperties($filter=id eq '"+property+"')")
	if filter != "" {
		link += "&$filter=" + queryEscape(filter)
	}
	var found []string
	for link != "" {
		var page struct {
			Value []struct {
				ID      string `json:"id"`
				Headers []struct {
					Name  string `json:"name"`
					Value string `json:"value"`
				} `json:"internetMessageHeaders"`
				Properties []struct {
					ID    string `json:"id"`
					Value string `json:"value"`
				} `json:"singleValueExtendedProperties"`
			} `json:"value"`
			NextLink string `json:"@odata.nextLink"`
		}
		if err := c.get(ctx, link, "", &page); err != nil {
			return nil, mapAccessError(err)
		}
		for _, m := range page.Value {
			match := false
			for _, h := range m.Headers {
				match = match || (strings.EqualFold(h.Name, name) && strings.TrimSpace(h.Value) == value)
			}
			for _, p := range m.Properties {
				match = match || (strings.EqualFold(p.ID, property) && strings.TrimSpace(p.Value) == value)
			}
			if match {
				found = append(found, m.ID)
			}
		}
		link = page.NextLink
	}
	return found, nil
}
