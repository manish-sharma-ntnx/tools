package config

import (
	"strings"
	"testing"
)

func ruleByID(id string) *DiscoveryRule {
	for i := range DiscoveryRules {
		if DiscoveryRules[i].ID == id {
			return &DiscoveryRules[i]
		}
	}
	return nil
}

func TestPCVersionRegexesPreferPCJobs(t *testing.T) {
	cases := []struct {
		ruleID  string
		job     string
		version string
		match   bool
	}{
		{ruleID: "lkg", job: "ganges-7.7-stable", version: "7.7", match: true},
		{ruleID: "lkg", job: "ganges-7.7-stable-pc", match: false},
		{ruleID: "lkg-c1", job: "ganges-7.7-stable-pc", version: "7.7", match: true},
		{ruleID: "lkg-c1", job: "ganges-7.7-stable", match: false},
		{ruleID: "lkg-c1", job: "ganges-7.6.9.3-stable-pc", version: "7.6.9.3", match: true},
		{ruleID: "smoke", job: "ganges-7.7-stable", version: "7.7", match: true},
		{ruleID: "smoke", job: "ganges-7.7-stable-pc", match: false},
		{ruleID: "smoke-pc", job: "ganges-7.7-stable-pc", version: "7.7", match: true},
		{ruleID: "lcc-local-c4", job: "msp-ganges-7.7", version: "7.7", match: true},
		{ruleID: "lcc-local-c4", job: "msp-ganges-7.7-pc", match: false},
		{ruleID: "lcc-local-c4-pc", job: "msp-ganges-7.7-pc", version: "7.7", match: true},
		{ruleID: "lcc-local-c4-pc", job: "msp-ganges-7.7", match: false},
		{ruleID: "lcc-local-pc", job: "msp-ganges-7.6-pc", version: "7.6", match: true},
		{ruleID: "glcc-pc", job: "msp-ganges-7.6-pc", version: "7.6", match: true},
		{ruleID: "glcc", job: "msp-ganges-7.6-pc", match: false},
		{ruleID: "precommit-pc-c4", job: "msp-ganges-7.7-pc", version: "7.7", match: true},
	}
	for _, tc := range cases {
		rule := ruleByID(tc.ruleID)
		if rule == nil {
			t.Fatalf("missing discovery rule %s", tc.ruleID)
		}
		m := rule.VersionRegex.FindStringSubmatch(tc.job)
		got := m != nil
		if got != tc.match {
			t.Errorf("%s vs %s: match=%v, want %v", tc.ruleID, tc.job, got, tc.match)
			continue
		}
		if tc.match && (len(m) < 2 || m[1] != tc.version) {
			t.Errorf("%s vs %s: version=%q, want %q", tc.ruleID, tc.job, m[1], tc.version)
		}
	}
}

func TestMasterGroupsSplitMspMasterAndMaster(t *testing.T) {
	want := map[string]string{
		"precommit-master": "msp-master",
		"lcc-local":        "msp-master",
		"glcc":             "msp-master",
		"lkg-valpromote":   "msp-master",
		"smoke":            "master",
		"lkg":              "master",
	}
	for id, group := range want {
		rule := ruleByID(id)
		if rule == nil {
			t.Fatalf("missing discovery rule %s", id)
		}
		if rule.MasterGroup != group {
			t.Errorf("%s MasterGroup=%q, want %q", id, rule.MasterGroup, group)
		}
	}
	vp := ruleByID("lkg-valpromote")
	if vp.Controller != "sbprod1" || vp.MasterName != "master" || vp.Lane != "LKG" {
		t.Fatalf("lkg-valpromote controller/name/lane = %s %s %s", vp.Controller, vp.MasterName, vp.Lane)
	}
	if got := strings.Join(vp.Parent, "/"); got != "Nupipe/LKG_ValPromote" {
		t.Fatalf("lkg-valpromote parent=%s", got)
	}
}

func TestPCRulesAreListedAfterNOSFallbacks(t *testing.T) {
	index := map[string]int{}
	for i, r := range DiscoveryRules {
		index[r.ID] = i
	}
	pairs := [][2]string{
		{"lcc-local", "lcc-local-pc"},
		{"lcc-local-c4", "lcc-local-c4-pc"},
		{"glcc", "glcc-pc"},
		{"smoke", "smoke-pc"},
		{"lkg", "lkg-c1"},
	}
	for _, p := range pairs {
		a, okA := index[p[0]]
		b, okB := index[p[1]]
		if !okA || !okB {
			t.Fatalf("missing rules %s / %s", p[0], p[1])
		}
		if b <= a {
			t.Errorf("%s must be listed after %s so PC upserts over NOS", p[1], p[0])
		}
	}
}
