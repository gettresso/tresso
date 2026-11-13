package api

import (
	"encoding/json"
	"testing"
)

func TestConferenceOutcomeReportsOnlyAMeetingThatIsNotThere(t *testing.T) {
	cases := []struct {
		name                               string
		made, known, pending, notSupported bool
		want                               string
	}{
		{name: "made", made: true, known: true, want: `{"workerId":"","outcome":"done"}`},
		{name: "made, though the request was refused once", made: true, known: true, notSupported: true, want: `{"workerId":"","outcome":"done"}`},
		{name: "still being made", known: true, pending: true, want: `{"workerId":"","outcome":"done","conferenceStatus":"pending"}`},
		{name: "not read back", known: false, want: `{"workerId":"","outcome":"done","conferenceStatus":"pending"}`},
		{name: "refused", known: true, want: `{"workerId":"","outcome":"done","conferenceStatus":"failed","conferenceError":"refused"}`},
		{name: "not supported", known: true, notSupported: true, want: `{"workerId":"","outcome":"done","conferenceStatus":"failed","conferenceError":"not_supported"}`},
		{name: "not supported, not read back", notSupported: true, want: `{"workerId":"","outcome":"done","conferenceStatus":"failed","conferenceError":"not_supported"}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			result := OperationResult{Outcome: OperationDone}
			ConferenceOutcome(&result, c.made, c.known, c.pending, c.notSupported)
			data, err := json.Marshal(result)
			if err != nil {
				t.Fatal(err)
			}
			if string(data) != c.want {
				t.Errorf("result = %s; want %s", data, c.want)
			}
		})
	}
}
