// Package httpapi serves the /api/* endpoints and the embedded web UI.
// Ported from server/index.js.
package httpapi

import (
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/nutanix/msp-pipeline-dashboard/internal/config"
	"github.com/nutanix/msp-pipeline-dashboard/internal/scheduler"
	"github.com/nutanix/msp-pipeline-dashboard/internal/slack"
	"github.com/nutanix/msp-pipeline-dashboard/internal/store"
)

var mimeByExt = map[string]string{
	".html": "text/html; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".svg":  "image/svg+xml",
	".png":  "image/png",
	".ico":  "image/x-icon",
	".json": "application/json; charset=utf-8",
}

// Handler builds the top-level mux. webFS is the embedded web/ directory.
func Handler(webFS fs.FS) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/health":
			handleHealth(w, r)
		case r.URL.Path == "/api/pipelines":
			handlePipelines(w, r)
		case r.URL.Path == "/api/refresh":
			handleRefresh(w, r)
		case r.URL.Path == "/api/alerts":
			handleAlerts(w, r)
		case r.URL.Path == "/api/digest/preview":
			handleDigestPreview(w, r)
		case r.URL.Path == "/api/digest/test":
			handleDigestTest(w, r)
		default:
			serveStatic(webFS, w, r)
		}
	})
	return mux
}

func sendJSON(w http.ResponseWriter, code int, obj any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(obj)
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	sendJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func handlePipelines(w http.ResponseWriter, _ *http.Request) {
	snap := store.GetSnapshot()
	if snap.GeneratedAt == 0 {
		snap = store.Poll(false) // cold start
	}
	sendJSON(w, http.StatusOK, snap)
}

func handleRefresh(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		force := r.URL.Query().Get("discovery") != "false"
		snap := store.Poll(force)
		sendJSON(w, http.StatusOK, map[string]any{"ok": true, "generatedAt": snap.GeneratedAt, "blocks": len(snap.VersionBlocks)})
	case http.MethodGet:
		snap := store.Poll(true)
		sendJSON(w, http.StatusOK, map[string]any{"ok": true, "generatedAt": snap.GeneratedAt})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func handleDigestPreview(w http.ResponseWriter, _ *http.Request) {
	failing := store.GetMasterFailures(config.MasterDigest.FailThreshold)
	out := make([]map[string]any, 0, len(failing))
	for _, c := range failing {
		out = append(out, map[string]any{
			"title": c.Title, "lane": c.Lane,
			"consecutiveFailures": c.ConsecutiveFailures,
			"lastBuildNumber":     c.LastBuildNumber, "url": c.URL,
		})
	}
	sendJSON(w, http.StatusOK, map[string]any{
		"threshold": config.MasterDigest.FailThreshold,
		"channel":   config.MasterDigest.Channel,
		"times":     config.MasterDigest.Times,
		"count":     len(failing),
		"failing":   out,
	})
}

func handleDigestTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	store.Poll(false)
	failing := store.GetMasterFailures(config.MasterDigest.FailThreshold)
	patchFailing := store.GetPatchFailures()
	devtestFailing := store.GetDevtestFailures()
	outcome := scheduler.FireDigestTest()
	sendJSON(w, http.StatusOK, map[string]any{
		"ok":               true,
		"posted":           outcome.Sent,
		"count":            len(failing),
		"patchCount":       len(patchFailing),
		"reason":           outcome.Reason,
		"channel":          config.MasterDigest.Channel,
		"slackEnabled":     config.Slack.Enabled,
		"hasBotToken":      config.Slack.BotToken != "",
		"patchThreshold":   config.Setting.PatchFailThreshold,
		"devtestCount":     len(devtestFailing),
		"devtestThreshold": config.Setting.DevtestFailThreshold,
		"successEnabled":   config.SuccessDigest.Enabled,
		"successThreshold": config.SuccessDigest.Threshold,
	})
}

// handleAlerts returns the persisted per-pipeline alert history plus computed
// frequency stats (alerts/day over the observed window, avg gap between alerts,
// and a last-7-day / last-30-day count).
func handleAlerts(w http.ResponseWriter, _ *http.Request) {
	hist := slack.GetAlertHistory()
	now := time.Now().UnixMilli()
	dayMs := int64(24 * 60 * 60 * 1000)

	type freq struct {
		Key         string  `json:"key"`
		Title       string  `json:"title"`
		Lane        string  `json:"lane,omitempty"`
		Version     string  `json:"version,omitempty"`
		URL         string  `json:"url,omitempty"`
		Count       int     `json:"count"`
		FirstAt     int64   `json:"firstAt"`
		LastAt      int64   `json:"lastAt"`
		Last7Days   int     `json:"last7Days"`
		Last30Days  int     `json:"last30Days"`
		PerDay      float64 `json:"perDay"`
		AvgGapHours float64 `json:"avgGapHours"`
		Timestamps  []int64 `json:"timestamps"`
	}

	out := make([]freq, 0, len(hist))
	totalAlerts := 0
	for _, h := range hist {
		totalAlerts += h.Count
		f := freq{
			Key: h.Key, Title: h.Title, Lane: h.Lane, Version: h.Version, URL: h.URL,
			Count: h.Count, FirstAt: h.FirstAt, LastAt: h.LastAt, Timestamps: h.Timestamps,
		}
		for _, ts := range h.Timestamps {
			if now-ts <= 7*dayMs {
				f.Last7Days++
			}
			if now-ts <= 30*dayMs {
				f.Last30Days++
			}
		}
		// Alerts per day over the observed span (first→now), min 1 day.
		spanDays := float64(now-h.FirstAt) / float64(dayMs)
		if spanDays < 1 {
			spanDays = 1
		}
		f.PerDay = round2(float64(h.Count) / spanDays)
		// Average gap between consecutive alerts, in hours.
		if h.Count > 1 {
			f.AvgGapHours = round2(float64(h.LastAt-h.FirstAt) / float64(h.Count-1) / float64(60*60*1000))
		}
		out = append(out, f)
	}

	sendJSON(w, http.StatusOK, map[string]any{
		"generatedAt":   now,
		"pipelineCount": len(out),
		"totalAlerts":   totalAlerts,
		"cooldownMs":    config.Slack.CooldownMs,
		"failThreshold": config.MasterDigest.FailThreshold,
		"pipelines":     out,
	})
}

func round2(f float64) float64 {
	return float64(int64(f*100+0.5)) / 100
}

func serveStatic(webFS fs.FS, w http.ResponseWriter, r *http.Request) {
	urlPath := r.URL.Path
	if urlPath == "/" || urlPath == "" {
		urlPath = "/index.html"
	}
	clean := path.Clean(urlPath)
	name := strings.TrimPrefix(clean, "/")
	if name == "" {
		name = "index.html"
	}

	b, err := fs.ReadFile(webFS, name)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("Not found"))
		return
	}
	ext := strings.ToLower(path.Ext(name))
	ct := mimeByExt[ext]
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(b)
}

// LogStartup prints the boot banner (parity with the Node server logs).
func LogStartup() {
	shownHost := config.Setting.Host
	if shownHost == "0.0.0.0" {
		shownHost = "<this-host-ip>"
	}
	log.Printf("[msp-dashboard] listening on http://%s:%d (bound %s)", shownHost, config.Setting.Port, config.Setting.Host)
	log.Printf("[msp-dashboard] poll interval: %.0fs, tracking last %d builds",
		config.Setting.PollInterval.Seconds(), config.Setting.BuildsToTrack)
}
