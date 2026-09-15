// Package model holds the shared data types for the dashboard snapshot.
//
// JSON field names are chosen to be byte-compatible with the original Node
// implementation's /api/pipelines payload so the existing web UI works unchanged.
package model

// Ptr returns a pointer to s, or nil when s is empty. Used so optional string
// fields serialize as JSON null (not "") to match the Node payload shape.
func Ptr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Deref returns *p or "" when p is nil.
func Deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// Build is one Jenkins build in a pipeline's last-N history.
//
// Result is a *string so an in-flight build (Jenkins result == null) serializes
// as JSON null, matching the Node payload exactly.
type Build struct {
	Number    int     `json:"number"`
	Status    string  `json:"status"`
	Result    *string `json:"result"`
	Building  bool    `json:"building"`
	Timestamp int64   `json:"timestamp"`
	Duration  int64   `json:"duration"`
	URL       string  `json:"url,omitempty"`
}

// Health mirrors Jenkins' healthReport[0].
type Health struct {
	Score       int    `json:"score"`
	Description string `json:"description"`
}

// Card is a normalized pipeline (one Jenkins job) with its status + history.
//
// Pointer string fields (Lane/Version/MasterGroup/SynthesizedFrom) serialize as
// JSON null when unset, matching the original Node payload exactly so the web UI
// sees an identical shape.
type Card struct {
	Key             string  `json:"key"`
	Title           string  `json:"title"`
	Subtitle        string  `json:"subtitle"`
	Lane            *string `json:"lane"`
	Version         *string `json:"version"`
	Controller      string  `json:"controller"`
	MasterGroup     *string `json:"masterGroup"`
	SynthesizedFrom *string `json:"synthesizedFrom"`
	URL             string  `json:"url"`
	Category        string  `json:"category"`
	Status          string  `json:"status"`
	Reachable       bool    `json:"reachable"`
	Error           string  `json:"error,omitempty"`
	Builds          []Build `json:"builds"`
	LastBuildNumber *int    `json:"lastBuildNumber"`
	LastTimestamp   int64   `json:"lastTimestamp"`
	Health          *Health `json:"health"`
	// SuccessRate is a pointer so it can serialize as null (unknown) like Node.
	SuccessRate          *int `json:"successRate"`
	CompletedCount       int  `json:"completedCount"`
	ConsecutiveFailures  int  `json:"consecutiveFailures"`
	ConsecutiveSuccesses int  `json:"consecutiveSuccesses"`
	AllFailing           bool `json:"allFailing"`
}

// VersionBlock clubs pipelines for one version (or the master group).
type VersionBlock struct {
	Version   string `json:"version"`
	Train     string `json:"train"`
	IsMaster  bool   `json:"isMaster"`
	Label     string `json:"label"`
	Pipelines []Card `json:"pipelines"`
}

// Stats is the KPI roll-up.
type Stats struct {
	Total       int `json:"total"`
	Success     int `json:"success"`
	Failed      int `json:"failed"`
	Running     int `json:"running"`
	Unstable    int `json:"unstable"`
	Unknown     int `json:"unknown"`
	Unreachable int `json:"unreachable"`
}

// Alert records a fully-failing pipeline that triggered a Slack alert.
type Alert struct {
	Key             string `json:"key"`
	Title           string `json:"title"`
	Lane            string `json:"lane,omitempty"`
	Version         string `json:"version,omitempty"`
	URL string `json:"url"`
	// Window is the actual consecutive-FAILURE streak observed (not the
	// fetch size). Slack text must use this so we never claim "10
	// consecutive" when the streak is shorter.
	Window          int    `json:"window"`
	LastBuildNumber *int   `json:"lastBuildNumber"`
	LastResult      string `json:"lastResult"`
	At              int64  `json:"at"`
	Outcome         any    `json:"outcome,omitempty"`
}

// DiscoveryError is a folder-listing failure for one rule.
type DiscoveryError struct {
	Rule  string `json:"rule"`
	Error string `json:"error"`
}

// Snapshot is the full /api/pipelines payload.
type Snapshot struct {
	GeneratedAt     int64            `json:"generatedAt"`
	Polling         bool             `json:"polling"`
	Static          []Card           `json:"static"`
	Masters         []VersionBlock   `json:"masters"`
	VersionBlocks   []VersionBlock   `json:"versionBlocks"`
	DiscoveryErrors []DiscoveryError `json:"discoveryErrors"`
	DiscoveredAt    int64            `json:"discoveredAt,omitempty"`
	Stats           Stats            `json:"stats"`
	Alerts          []Alert          `json:"alerts"`
}
