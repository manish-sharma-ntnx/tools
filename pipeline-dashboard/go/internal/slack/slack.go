// Package slack handles failure alerts and the master-pipeline digest.
// Ported from server/slack.js. Transport priority: webhook > bot token > log-only.
package slack

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/nutanix/msp-pipeline-dashboard/internal/config"
	"github.com/nutanix/msp-pipeline-dashboard/internal/model"
)

var httpClient = &http.Client{Timeout: 15 * time.Second}

func stateFile() string {
	return filepath.Join(config.Setting.DataDir, "alert-state.json")
}

// AlertHistory is the persisted record for one pipeline: how many alerts fired
// and when (most-recent-last, capped to keep the state file small).
type AlertHistory struct {
	Key        string  `json:"key"`
	Title      string  `json:"title"`
	Lane       string  `json:"lane,omitempty"`
	Version    string  `json:"version,omitempty"`
	URL        string  `json:"url,omitempty"`
	Count      int     `json:"count"`
	FirstAt    int64   `json:"firstAt"`
	LastAt     int64   `json:"lastAt"`
	Timestamps []int64 `json:"timestamps"`
}

// maxTimestampsPerPipeline caps stored alert timestamps so the state file stays
// bounded even for a chronically-failing pipeline.
const maxTimestampsPerPipeline = 200

type alertState struct {
	LastAlertAt map[string]int64         `json:"lastAlertAt"`
	History     map[string]*AlertHistory `json:"history"`
}

var stateMu sync.Mutex

func loadState() alertState {
	b, err := os.ReadFile(stateFile())
	if err != nil {
		return alertState{LastAlertAt: map[string]int64{}, History: map[string]*AlertHistory{}}
	}
	var s alertState
	if err := json.Unmarshal(b, &s); err != nil {
		return alertState{LastAlertAt: map[string]int64{}, History: map[string]*AlertHistory{}}
	}
	if s.LastAlertAt == nil {
		s.LastAlertAt = map[string]int64{}
	}
	if s.History == nil {
		s.History = map[string]*AlertHistory{}
	}
	return s
}

func saveState(s alertState) {
	if err := os.MkdirAll(config.Setting.DataDir, 0o755); err != nil {
		log.Printf("[slack] failed to create data dir: %v", err)
		return
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	if err := os.WriteFile(stateFile(), b, 0o644); err != nil {
		log.Printf("[slack] failed to persist alert state: %v", err)
	}
}

// recordHistory appends a fired-alert timestamp for a pipeline (called with the
// state lock held). Timestamps are capped to keep the file bounded.
func recordHistory(state *alertState, e model.Alert, now int64) {
	h := state.History[e.Key]
	if h == nil {
		h = &AlertHistory{Key: e.Key, FirstAt: now}
		state.History[e.Key] = h
	}
	// Keep identifying metadata fresh (titles/urls can change across versions).
	h.Title = e.Title
	h.Lane = e.Lane
	h.Version = e.Version
	h.URL = e.URL
	h.Count++
	h.LastAt = now
	h.Timestamps = append(h.Timestamps, now)
	if len(h.Timestamps) > maxTimestampsPerPipeline {
		h.Timestamps = h.Timestamps[len(h.Timestamps)-maxTimestampsPerPipeline:]
	}
}

// GetAlertHistory returns a snapshot copy of the persisted per-pipeline alert
// history, newest-alert-first by LastAt.
func GetAlertHistory() []AlertHistory {
	stateMu.Lock()
	state := loadState()
	stateMu.Unlock()
	out := make([]AlertHistory, 0, len(state.History))
	for _, h := range state.History {
		if h == nil {
			continue
		}
		ts := make([]int64, len(h.Timestamps))
		copy(ts, h.Timestamps)
		cp := *h
		cp.Timestamps = ts
		out = append(out, cp)
	}
	for i := 0; i < len(out); i++ {
		for j := i + 1; j < len(out); j++ {
			if out[j].LastAt > out[i].LastAt {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out
}

// postResult is a POST outcome.
type postResult struct {
	status int
	body   string
}

func postJSON(url string, headers map[string]string, payload any) postResult {
	body, _ := json.Marshal(payload)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return postResult{0, err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return postResult{0, err.Error()}
	}
	defer resp.Body.Close()
	buf := new(bytes.Buffer)
	buf.ReadFrom(resp.Body)
	return postResult{resp.StatusCode, buf.String()}
}

// Outcome is returned to the store for the alert ledger.
type Outcome struct {
	Sent    bool   `json:"sent"`
	Skipped bool   `json:"skipped,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

func buildMessage(e model.Alert) (string, []any) {
	buildNo := "—"
	if e.LastBuildNumber != nil {
		buildNo = fmt.Sprintf("#%d", *e.LastBuildNumber)
	}
	dashURL := config.DashboardURL()

	lines := []string{
		fmt.Sprintf(":rotating_light: *MSP Pipeline Alert* %s", config.Slack.Mention),
		fmt.Sprintf("*%s* has *failed the last %d consecutive builds*.", e.Title, e.Window),
	}
	if e.Version != "" && e.Version != "master" {
		lines = append(lines, fmt.Sprintf("Version: `%s`", e.Version))
	}
	lines = append(lines, fmt.Sprintf("Lane: `%s`", e.Lane))
	lines = append(lines, fmt.Sprintf("Latest build: %s — %s", buildNo, e.LastResult))
	if e.URL != "" {
		lines = append(lines, fmt.Sprintf("<%s|Open in Jenkins>", e.URL))
	}
	if dashURL != "" {
		lines = append(lines, "Dashboard: "+dashURL)
	}

	detail := make([]string, 0, 4)
	if e.Version != "" && e.Version != "master" {
		detail = append(detail, fmt.Sprintf("Version: `%s`", e.Version))
	}
	detail = append(detail, fmt.Sprintf("Lane: `%s`", e.Lane))
	detail = append(detail, fmt.Sprintf("Latest build: %s — %s", buildNo, e.LastResult))
	if e.URL != "" {
		detail = append(detail, fmt.Sprintf("<%s|Jenkins>", e.URL))
	}

	blocks := []any{
		map[string]any{"type": "header", "text": map[string]any{"type": "plain_text", "text": "MSP Pipeline Alert", "emoji": true}},
		map[string]any{"type": "section", "text": map[string]any{"type": "mrkdwn",
			"text": fmt.Sprintf("*%s* has *failed the last %d consecutive builds*.", e.Title, e.Window)}},
		map[string]any{"type": "section", "text": map[string]any{"type": "mrkdwn", "text": strings.Join(detail, "\n")}},
	}
	if dashURL != "" {
		blocks = append(blocks, map[string]any{"type": "section", "text": map[string]any{"type": "mrkdwn",
			"text": fmt.Sprintf(":bar_chart: <%s|Open MSP Pipeline Dashboard>", dashURL)}})
	}
	blocks = append(blocks, map[string]any{"type": "context", "elements": []any{
		map[string]any{"type": "mrkdwn", "text": config.Slack.Mention},
	}})

	return strings.Join(lines, "\n"), blocks
}

// SendFailureAlert posts an alert honoring the per-pipeline cooldown.
//
// The alert EVENT (pipeline met the fully-failing rule and passed cooldown) is
// recorded to persistent history regardless of whether a Slack transport is
// configured, so the Alerts tab reflects genuine events even in log-only mode.
func SendFailureAlert(e model.Alert) any {
	if !config.Slack.Enabled {
		log.Printf("[slack] (SLACK_ENABLED=false) would alert -> %s: %s", config.Slack.Channel, e.Title)
		return Outcome{Sent: false, Skipped: true, Reason: "disabled"}
	}
	stateMu.Lock()
	state := loadState()
	now := time.Now().UnixMilli()
	last := state.LastAlertAt[e.Key]
	if now-last < config.Slack.CooldownMs {
		stateMu.Unlock()
		return Outcome{Sent: false, Skipped: true, Reason: "cooldown"}
	}
	// The alert fires now: persist the cooldown stamp + history up front.
	state.LastAlertAt[e.Key] = now
	recordHistory(&state, e, now)
	saveState(state)
	stateMu.Unlock()

	text, blocks := buildMessage(e)
	var res postResult

	switch {
	case config.Slack.WebhookURL != "":
		res = postJSON(config.Slack.WebhookURL, nil, map[string]any{"channel": config.Slack.Channel, "text": text, "blocks": blocks})
	case config.Slack.BotToken != "":
		res = postJSON("https://slack.com/api/chat.postMessage",
			map[string]string{"Authorization": "Bearer " + config.Slack.BotToken},
			map[string]any{"channel": config.Slack.Channel, "text": text, "link_names": true, "blocks": blocks})
	default:
		log.Printf("[slack] (not configured) would alert -> %s:\n%s", config.Slack.Channel, text)
		return Outcome{Sent: false, Skipped: true, Reason: "no-transport"}
	}

	if slackOK(res) {
		return Outcome{Sent: true}
	}
	reason := slackFailReason(res)
	log.Printf("[slack] send failed %s body=%s", reason, res.body)
	return Outcome{Sent: false, Reason: reason}
}

// VerifyAuth runs auth.test on the configured bot token.
type AuthResult struct {
	OK    bool
	User  string
	Team  string
	Error string
}

// TestOptions controls behavior of the manual /api/digest/test posting path:
// it forces the test message onto a dedicated channel and suppresses the
// @msp-help mention so the verification post does not ping the live channel.
type TestOptions struct {
	Channel     string
	OmitMention bool
}

// postTo publishes text+blocks to a channel (resolved from args or config),
// honoring the SLACK_ENABLED master switch. Returns an Outcome suitable for
// the API response.
func postTo(opts *TestOptions, text string, blocks []any) Outcome {
	if !config.Slack.Enabled {
		log.Printf("[slack] (SLACK_ENABLED=false) would post -> %s:\n%s", channelFor(opts), text)
		return Outcome{Sent: false, Skipped: true, Reason: "disabled"}
	}
	if config.Slack.BotToken == "" {
		log.Printf("[slack] (no SLACK_BOT_TOKEN) would post -> %s:\n%s", channelFor(opts), text)
		return Outcome{Sent: false, Skipped: true, Reason: "no-bot-token"}
	}
	payload := map[string]any{"channel": channelFor(opts), "text": text, "link_names": true}
	if blocks != nil {
		payload["blocks"] = blocks
	}
	res := postJSON("https://slack.com/api/chat.postMessage",
		map[string]string{"Authorization": "Bearer " + config.Slack.BotToken}, payload)
	if !slackOK(res) {
		reason := slackFailReason(res)
		log.Printf("[slack] postTo failed %s body=%s", reason, res.body)
		return Outcome{Sent: false, Reason: reason}
	}
	return Outcome{Sent: true}
}

func channelFor(opts *TestOptions) string {
	if opts != nil && opts.Channel != "" {
		return opts.Channel
	}
	return config.Slack.Channel
}

func verifyAuth() AuthResult {
	if config.Slack.BotToken == "" {
		return AuthResult{OK: false, Error: "no-bot-token"}
	}
	res := postJSON("https://slack.com/api/auth.test",
		map[string]string{"Authorization": "Bearer " + config.Slack.BotToken}, map[string]any{})
	var parsed struct {
		OK    bool   `json:"ok"`
		User  string `json:"user"`
		Team  string `json:"team"`
		Error string `json:"error"`
	}
	_ = json.Unmarshal([]byte(res.body), &parsed)
	return AuthResult{OK: parsed.OK, User: parsed.User, Team: parsed.Team, Error: parsed.Error}
}

// VerifyAuth runs auth.test on the configured bot token.
func VerifyAuth() AuthResult {
	return verifyAuth()
}

// postMessage posts via the bot token (chat.postMessage), optional Block Kit.
func postMessage(channel, text string, blocks []any) Outcome {
	if !config.Slack.Enabled {
		log.Printf("[slack] (SLACK_ENABLED=false) would post -> %s:\n%s", channel, text)
		return Outcome{Sent: false, Skipped: true, Reason: "disabled"}
	}
	if config.Slack.BotToken == "" {
		log.Printf("[slack] (no SLACK_BOT_TOKEN) would post -> %s:\n%s", channel, text)
		return Outcome{Sent: false, Skipped: true, Reason: "no-bot-token"}
	}
	payload := map[string]any{"channel": channel, "text": text, "link_names": true}
	if blocks != nil {
		payload["blocks"] = blocks
	}
	res := postJSON("https://slack.com/api/chat.postMessage",
		map[string]string{"Authorization": "Bearer " + config.Slack.BotToken}, payload)
	if !slackOK(res) {
		reason := slackFailReason(res)
		log.Printf("[slack] postMessage failed %s body=%s", reason, res.body)
		return Outcome{Sent: false, Reason: reason}
	}
	return Outcome{Sent: true}
}

func slackOK(res postResult) bool {
	return res.status >= 200 && res.status < 300 && !strings.Contains(res.body, `"ok":false`)
}

func slackFailReason(res postResult) string {
	var parsed struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal([]byte(res.body), &parsed)
	if parsed.Error != "" {
		return parsed.Error
	}
	if res.body != "" && res.status == 0 {
		return res.body
	}
	return fmt.Sprintf("http %d", res.status)
}

var statusEmoji = map[string]string{
	"success":     ":large_green_circle:",
	"failed":      ":red_circle:",
	"aborted":     ":black_circle:",
	"unstable":    ":large_yellow_circle:",
	"running":     ":arrows_counterclockwise:",
	"unreachable": ":warning:",
	"unknown":     ":white_circle:",
}

// DigestMeta carries per-post context.
type DigestMeta struct {
	Threshold    int
	When         string
	DashboardURL string
	TestMode     bool   // true for /api/digest/test → post to #test-msp, omit @msp-help
}

func buildMasterDigest(failing []model.Card, meta DigestMeta) (string, []any) {
	threshold := meta.Threshold
	if threshold == 0 {
		threshold = config.MasterDigest.FailThreshold
	}
	header := fmt.Sprintf(":rotating_light: MSP Master Pipeline Alert — %d pipeline(s) failing ≥ %d builds", len(failing), threshold)

	lines := make([]string, 0, len(failing))
	for _, c := range failing {
		emoji := statusEmoji[c.Status]
		if emoji == "" {
			emoji = statusEmoji["unknown"]
		}
		lane := ""
		if laneStr := model.Deref(c.Lane); laneStr != "" {
			lane = fmt.Sprintf(" _(%s)_", laneStr)
		}
		buildNo := "n/a"
		if c.LastBuildNumber != nil {
			buildNo = fmt.Sprintf("#%d", *c.LastBuildNumber)
		}
		link := ""
		if c.URL != "" {
			link = fmt.Sprintf("<%s|Jenkins>", c.URL)
		}
		lines = append(lines, strings.TrimSpace(fmt.Sprintf("%s *%s*%s — %d consecutive failures, latest %s %s",
			emoji, c.Title, lane, c.ConsecutiveFailures, buildNo, link)))
	}

	dashURL := meta.DashboardURL
	if dashURL == "" {
		dashURL = config.DashboardURL()
	}

	text := header + "\n" + strings.Join(lines, "\n")
	if dashURL != "" {
		text += "\nDashboard: " + dashURL
	}

	when := meta.When
	if when == "" {
		when = time.Now().UTC().Format(time.RFC3339)
	}

	blocks := []any{
		map[string]any{"type": "header", "text": map[string]any{"type": "plain_text", "text": "MSP Master Pipeline Alert", "emoji": true}},
		map[string]any{"type": "section", "text": map[string]any{"type": "mrkdwn",
			"text": fmt.Sprintf("%d master pipeline(s) have failed *≥ %d consecutive builds*.", len(failing), threshold)}},
		map[string]any{"type": "section", "text": map[string]any{"type": "mrkdwn", "text": strings.Join(lines, "\n")}},
	}
	if dashURL != "" {
		blocks = append(blocks, map[string]any{"type": "section", "text": map[string]any{"type": "mrkdwn",
			"text": fmt.Sprintf(":bar_chart: <%s|Open MSP Pipeline Dashboard>", dashURL)}})
	}
	blocks = append(blocks, map[string]any{"type": "context", "elements": []any{
		map[string]any{"type": "mrkdwn", "text": fmt.Sprintf("Digest @ %s %s", when, mentionFor(meta))},
	}})

	return text, blocks
}

// mentionFor returns the @msp-help mention string, or empty in test mode so
// /api/digest/test does not ping the live channel.
func mentionFor(meta DigestMeta) string {
	if meta.TestMode {
		return ""
	}
	return config.Slack.Mention
}

// channelForDigest routes test messages to #test-msp; normal digests use the
// configured master-digest channel.
func channelForDigest(meta DigestMeta) string {
	if meta.TestMode {
		return "#test-msp"
	}
	return config.MasterDigest.Channel
}

// PostMasterDigest posts the master-failure digest. Empty input posts nothing.
func PostMasterDigest(failing []model.Card, meta DigestMeta) Outcome {
	if len(failing) == 0 {
		return Outcome{Sent: false, Skipped: true, Reason: "nothing-failing"}
	}
	text, blocks := buildMasterDigest(failing, meta)
	return postMessage(channelForDigest(meta), text, blocks)
}

func buildAllClear(meta DigestMeta) (string, []any) {
	threshold := meta.Threshold
	if threshold == 0 {
		threshold = config.MasterDigest.FailThreshold
	}
	dashURL := meta.DashboardURL
	if dashURL == "" {
		dashURL = config.DashboardURL()
	}
	when := meta.When
	if when == "" {
		when = time.Now().UTC().Format(time.RFC3339)
	}
	// Mention: empty for the /api/digest/test verification post so it does not
	// ping @msp-help on the live channel.
	mention := config.Slack.Mention
	if meta.TestMode {
		mention = ""
	}
	text := fmt.Sprintf(":white_check_mark: MSP Master Pipeline Digest — all clear\nNo master pipeline is failing ≥ %d consecutive builds.", threshold)
	if dashURL != "" {
		text += "\nDashboard: " + dashURL
	}
	blocks := []any{
		map[string]any{"type": "header", "text": map[string]any{"type": "plain_text", "text": "MSP Master Pipeline Digest", "emoji": true}},
		map[string]any{"type": "section", "text": map[string]any{"type": "mrkdwn",
			"text": fmt.Sprintf(":white_check_mark: All clear — no master pipeline is failing *≥ %d consecutive builds*.", threshold)}},
	}
	if dashURL != "" {
		blocks = append(blocks, map[string]any{"type": "section", "text": map[string]any{"type": "mrkdwn",
			"text": fmt.Sprintf(":bar_chart: <%s|Open MSP Pipeline Dashboard>", dashURL)}})
	}
	ctxText := "Test post"
	if mention != "" {
		ctxText += " " + mention
	}
	blocks = append(blocks, map[string]any{"type": "context", "elements": []any{
		map[string]any{"type": "mrkdwn", "text": fmt.Sprintf("%s @ %s", ctxText, when)},
	}})
	return text, blocks
}

// PostAllClear posts a connectivity / all-clear message (used by /api/digest/test
// when nothing currently meets the failure threshold).
func PostAllClear(meta DigestMeta) Outcome {
	text, blocks := buildAllClear(meta)
	return postMessage(channelForDigest(meta), text, blocks)
}
