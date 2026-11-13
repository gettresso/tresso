package googlecal

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"tresso/sync/internal/ical"
)

// eventTime is Google's start, end or originalStartTime: a date for all-day events, else a date-time with an
// optional IANA zone.
type eventTime struct {
	Date     string `json:"date,omitempty"`
	DateTime string `json:"dateTime,omitempty"`
	TimeZone string `json:"timeZone,omitempty"`
}

type person struct {
	Email          string `json:"email,omitempty"`
	DisplayName    string `json:"displayName,omitempty"`
	Self           bool   `json:"self,omitempty"`
	Organizer      bool   `json:"organizer,omitempty"`
	Optional       bool   `json:"optional,omitempty"`
	Resource       bool   `json:"resource,omitempty"`
	ResponseStatus string `json:"responseStatus,omitempty"`
	Comment        string `json:"comment,omitempty"`
}

type reminder struct {
	Method  string `json:"method"`
	Minutes int    `json:"minutes"`
}

type reminders struct {
	UseDefault bool       `json:"useDefault"`
	Overrides  []reminder `json:"overrides"`
}

type entryPoint struct {
	EntryPointType string `json:"entryPointType"`
	URI            string `json:"uri"`
	Label          string `json:"label,omitempty"`
	Pin            string `json:"pin,omitempty"`
}

type conferenceData struct {
	EntryPoints        []entryPoint `json:"entryPoints,omitempty"`
	ConferenceID       string       `json:"conferenceId,omitempty"`
	ConferenceSolution *struct {
		Key struct {
			Type string `json:"type"`
		} `json:"key"`
		Name string `json:"name,omitempty"`
	} `json:"conferenceSolution,omitempty"`
	CreateRequest *createRequest `json:"createRequest,omitempty"`
}

type createRequest struct {
	RequestID             string `json:"requestId"`
	ConferenceSolutionKey struct {
		Type string `json:"type"`
	} `json:"conferenceSolutionKey"`
	// Status is Google's answer to the request: pending, success or failure. Never sent.
	Status *struct {
		StatusCode string `json:"statusCode"`
	} `json:"status,omitempty"`
}

// meetSolution is Google's conference solution type of a Google Meet meeting.
const meetSolution = "hangoutsMeet"

// joinLink is the meeting's link as Tresso reads it: the first video entry point with an https link, empty when there
// is none.
func (d *conferenceData) joinLink() string {
	if d == nil {
		return ""
	}
	for _, entry := range d.EntryPoints {
		if entry.EntryPointType == "video" && strings.HasPrefix(entry.URI, "https://") {
			return entry.URI
		}
	}
	return ""
}

// hasMeet: the event has a Google Meet meeting as the reader sees one (X-GOOGLE-CONFERENCE): the hangoutsMeet
// solution with an https video entry point.
func (d *conferenceData) hasMeet() bool {
	return d != nil && d.ConferenceSolution != nil && d.ConferenceSolution.Key.Type == meetSolution && d.joinLink() != ""
}

// pending: Google is still making the meeting a create request asked for.
func (d *conferenceData) pending() bool {
	return d != nil && d.CreateRequest != nil && d.CreateRequest.Status != nil && d.CreateRequest.Status.StatusCode == "pending"
}

// event is a Google Calendar event resource, as far as Tresso reads and writes it.
type event struct {
	ID                 string          `json:"id,omitempty"`
	ETag               string          `json:"etag,omitempty"`
	Status             string          `json:"status,omitempty"`
	ICalUID            string          `json:"iCalUID,omitempty"`
	Sequence           int             `json:"sequence,omitempty"`
	Updated            string          `json:"updated,omitempty"`
	Summary            string          `json:"summary,omitempty"`
	Description        string          `json:"description,omitempty"`
	Location           string          `json:"location,omitempty"`
	Start              *eventTime      `json:"start,omitempty"`
	End                *eventTime      `json:"end,omitempty"`
	EndTimeUnspecified bool            `json:"endTimeUnspecified,omitempty"`
	Recurrence         []string        `json:"recurrence,omitempty"`
	RecurringEventID   string          `json:"recurringEventId,omitempty"`
	OriginalStartTime  *eventTime      `json:"originalStartTime,omitempty"`
	Transparency       string          `json:"transparency,omitempty"`
	Visibility         string          `json:"visibility,omitempty"`
	Organizer          *person         `json:"organizer,omitempty"`
	Attendees          []person        `json:"attendees,omitempty"`
	Reminders          *reminders      `json:"reminders,omitempty"`
	ConferenceData     *conferenceData `json:"conferenceData,omitempty"`
	Source             *struct {
		URL   string `json:"url"`
		Title string `json:"title,omitempty"`
	} `json:"source,omitempty"`
}

func (e event) cancelled() bool {
	return e.Status == "cancelled"
}

// series is one resource as the API stores it: a single event or recurring master (nil when only exceptions are
// known) with its exceptions, cancelled ones included.
type series struct {
	master     *event
	exceptions []event
}

// events is the master (when there is one) and every exception of the resource.
func (s series) events() []event {
	out := make([]event, 0, len(s.exceptions)+1)
	if s.master != nil {
		out = append(out, *s.master)
	}
	return append(out, s.exceptions...)
}

// objectID is the resource a Google event belongs to: the master's id for exceptions, its own id otherwise.
func objectID(e event) string {
	if e.RecurringEventID != "" {
		return e.RecurringEventID
	}
	return e.ID
}

// etag combines the ETags of the master and its exceptions, so a change to any of them changes the resource.
func (s series) etag() string {
	masterTag := ""
	if s.master != nil {
		masterTag = s.master.ETag
	}
	if len(s.exceptions) == 0 {
		return strings.Trim(masterTag, `"`)
	}
	tags := make([]string, 0, len(s.exceptions))
	for _, exception := range s.exceptions {
		tags = append(tags, exception.ID+"="+exception.ETag)
	}
	sort.Strings(tags)
	sum := sha256.Sum256([]byte(masterTag + "\n" + strings.Join(tags, "\n")))
	return hex.EncodeToString(sum[:16])
}

// calendarInfo is what the conversion needs from the calendar.
type calendarInfo struct {
	TimeZone         string
	DefaultReminders []reminder
}

// toICalendar writes the series as one iCalendar object, the way the API stores it. Without a master (the user was
// invited to one occurrence only) the object holds just the occurrences.
func (s series) toICalendar(info calendarInfo) (string, error) {
	if !s.exists() {
		return "", fmt.Errorf("google: the event is deleted")
	}
	cal := ical.Calendar()
	var master *ical.Component
	seriesZone := info.TimeZone
	if s.master != nil {
		var err error
		if master, err = toVEvent(*s.master, info, nil); err != nil {
			return "", err
		}
		seriesZone = zoneOf(s.master.Start, info)
		cal.Children = append(cal.Children, master)
	}
	uid := s.uid()
	for _, exception := range s.exceptions {
		if exception.OriginalStartTime == nil {
			continue
		}
		original, err := googleTime(*exception.OriginalStartTime, seriesZone)
		if err != nil {
			return "", err
		}
		if exception.cancelled() {
			// A cancelled occurrence is an EXDATE of the series, in the form of its start.
			if master != nil {
				master.Props = append(master.Props, ical.TimeProperty("EXDATE", original))
			}
			continue
		}
		override, err := toVEvent(exception, info, &original)
		if err != nil {
			return "", err
		}
		override.Remove("UID")
		override.Props = append([]ical.Property{{Name: "UID", Value: ical.EscapeText(uid)}}, override.Props...)
		cal.Children = append(cal.Children, override)
	}
	return cal.Serialize(), nil
}

func (s series) uid() string {
	if s.master != nil {
		if s.master.ICalUID != "" {
			return s.master.ICalUID
		}
		return s.master.ID + "@google.com"
	}
	for _, exception := range s.exceptions {
		if exception.ICalUID != "" {
			return exception.ICalUID
		}
	}
	return s.exceptions[0].RecurringEventID + "@google.com"
}

// zoneOf is the zone a series' times are in: its start's, else the calendar's.
func zoneOf(t *eventTime, info calendarInfo) string {
	if t != nil && t.TimeZone != "" {
		return t.TimeZone
	}
	return info.TimeZone
}

// googleTime reads a Google time; a date-time without a zone of its own is shown in zone.
func googleTime(t eventTime, zone string) (ical.Time, error) {
	if t.Date != "" {
		d, err := time.Parse("2006-01-02", t.Date)
		if err != nil {
			return ical.Time{}, fmt.Errorf("google: date %q: %w", t.Date, err)
		}
		return ical.Time{T: d, Date: true}, nil
	}
	instant, err := time.Parse(time.RFC3339, t.DateTime)
	if err != nil {
		return ical.Time{}, fmt.Errorf("google: date-time %q: %w", t.DateTime, err)
	}
	if t.TimeZone != "" {
		zone = t.TimeZone
	}
	if zone == "" || zone == "UTC" || zone == "Etc/UTC" {
		return ical.Time{T: instant.UTC()}, nil
	}
	if _, name, err := ical.ZoneOf(zone); err == nil {
		return ical.Time{T: instant, Zone: name}, nil
	}
	return ical.Time{T: instant.UTC()}, nil
}

func toVEvent(e event, info calendarInfo, recurrenceID *ical.Time) (*ical.Component, error) {
	v := &ical.Component{Name: "VEVENT"}
	uid := e.ICalUID
	if uid == "" {
		uid = e.ID + "@google.com"
	}
	v.AddText("UID", uid)
	stamp := time.Now().UTC()
	if updated, err := time.Parse(time.RFC3339, e.Updated); err == nil {
		stamp = updated.UTC()
		v.Add("LAST-MODIFIED", stamp.Format("20060102T150405Z"))
	}
	v.Props = append([]ical.Property{{Name: "DTSTAMP", Value: stamp.Format("20060102T150405Z")}}, v.Props...)
	if recurrenceID != nil {
		v.Props = append(v.Props, ical.TimeProperty("RECURRENCE-ID", *recurrenceID))
	}
	if e.Start == nil {
		return nil, fmt.Errorf("google: event %s has no start", e.ID)
	}
	zone := zoneOf(e.Start, info)
	start, err := googleTime(*e.Start, zone)
	if err != nil {
		return nil, err
	}
	v.Props = append(v.Props, ical.TimeProperty("DTSTART", start))
	if e.End != nil && !e.EndTimeUnspecified {
		end, err := googleTime(*e.End, zoneOf(e.End, info))
		if err != nil {
			return nil, err
		}
		v.Props = append(v.Props, ical.TimeProperty("DTEND", end))
	}
	if recurrenceID == nil {
		for _, line := range e.Recurrence {
			prop, err := ical.ParseContentLine(line)
			if err != nil {
				return nil, fmt.Errorf("google: recurrence of %s: %w", e.ID, err)
			}
			switch prop.Name {
			case "RRULE", "EXDATE", "RDATE":
				v.Props = append(v.Props, prop)
			}
		}
	}
	if e.Sequence > 0 {
		v.Add("SEQUENCE", strconv.Itoa(e.Sequence))
	}
	v.AddText("SUMMARY", e.Summary)
	v.AddText("DESCRIPTION", e.Description)
	v.AddText("LOCATION", e.Location)
	if e.Source != nil && strings.HasPrefix(e.Source.URL, "https://") {
		v.Add("URL", e.Source.URL)
	}
	switch e.Status {
	case "tentative":
		v.Add("STATUS", "TENTATIVE")
	case "cancelled":
		v.Add("STATUS", "CANCELLED")
	default:
		v.Add("STATUS", "CONFIRMED")
	}
	if e.Transparency == "transparent" {
		v.Add("TRANSP", "TRANSPARENT")
	} else {
		v.Add("TRANSP", "OPAQUE")
	}
	switch e.Visibility {
	case "private":
		v.Add("CLASS", "PRIVATE")
	case "confidential":
		v.Add("CLASS", "CONFIDENTIAL")
	case "public":
		v.Add("CLASS", "PUBLIC")
	}
	if e.Organizer != nil && e.Organizer.Email != "" {
		v.Add("ORGANIZER", "mailto:"+e.Organizer.Email, nameParam(e.Organizer.DisplayName)...)
	}
	for _, attendee := range e.Attendees {
		if attendee.Email == "" {
			continue
		}
		params := nameParam(attendee.DisplayName)
		params = append(params, ical.Param{Name: "PARTSTAT", Values: []string{partstat(attendee.ResponseStatus)}})
		role := "REQ-PARTICIPANT"
		if attendee.Optional {
			role = "OPT-PARTICIPANT"
		}
		params = append(params, ical.Param{Name: "ROLE", Values: []string{role}})
		if attendee.Resource {
			params = append(params, ical.Param{Name: "CUTYPE", Values: []string{"RESOURCE"}})
		}
		if attendee.ResponseStatus == "needsAction" || attendee.ResponseStatus == "" {
			params = append(params, ical.Param{Name: "RSVP", Values: []string{"TRUE"}})
		}
		v.Add("ATTENDEE", "mailto:"+attendee.Email, params...)
	}
	for _, r := range remindersOf(e, info) {
		alarm := &ical.Component{Name: "VALARM"}
		if r.Method == "email" {
			alarm.Add("ACTION", "EMAIL")
			alarm.AddText("SUMMARY", e.Summary)
			alarm.AddText("DESCRIPTION", "Reminder")
		} else {
			alarm.Add("ACTION", "DISPLAY")
			alarm.AddText("DESCRIPTION", "Reminder")
		}
		alarm.Add("TRIGGER", fmt.Sprintf("-PT%dM", r.Minutes))
		v.Children = append(v.Children, alarm)
	}
	writeConference(v, e.ConferenceData)
	return v, nil
}

func nameParam(name string) []ical.Param {
	if name == "" {
		return nil
	}
	return []ical.Param{{Name: "CN", Values: []string{name}}}
}

func remindersOf(e event, info calendarInfo) []reminder {
	if e.Reminders == nil || e.Reminders.UseDefault {
		return info.DefaultReminders
	}
	return e.Reminders.Overrides
}

// writeConference writes the meeting as RFC 7986 CONFERENCE properties plus X-GOOGLE-CONFERENCE for Meet, which the
// API's conference detector reads.
func writeConference(v *ical.Component, data *conferenceData) {
	if data == nil {
		return
	}
	meet := data.ConferenceSolution != nil && data.ConferenceSolution.Key.Type == meetSolution
	for _, entry := range data.EntryPoints {
		switch entry.EntryPointType {
		case "video":
			if !strings.HasPrefix(entry.URI, "https://") {
				continue
			}
			params := []ical.Param{{Name: "VALUE", Values: []string{"URI"}}, {Name: "FEATURE", Values: []string{"VIDEO"}}}
			if data.ConferenceSolution != nil && data.ConferenceSolution.Name != "" {
				params = append(params, ical.Param{Name: "LABEL", Values: []string{data.ConferenceSolution.Name}})
			}
			v.Add("CONFERENCE", entry.URI, params...)
			if meet {
				v.Add("X-GOOGLE-CONFERENCE", entry.URI)
			}
		case "phone":
			if strings.HasPrefix(entry.URI, "tel:") {
				v.Add("CONFERENCE", entry.URI, ical.Param{Name: "VALUE", Values: []string{"URI"}}, ical.Param{Name: "FEATURE", Values: []string{"PHONE"}})
			}
		}
	}
}

func partstat(response string) string {
	switch response {
	case "accepted":
		return "ACCEPTED"
	case "declined":
		return "DECLINED"
	case "tentative":
		return "TENTATIVE"
	default:
		return "NEEDS-ACTION"
	}
}

func responseStatus(partstat string) string {
	switch strings.ToUpper(partstat) {
	case "ACCEPTED":
		return "accepted"
	case "DECLINED":
		return "declined"
	case "TENTATIVE":
		return "tentative"
	default:
		return "needsAction"
	}
}
