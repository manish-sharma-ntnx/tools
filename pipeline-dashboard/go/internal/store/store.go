// Package store runs the poll loop: fetch jobs, normalize to cards, compute
// last-10 math, assemble the snapshot, and fire alerts. Ported from
// server/store.js. The snapshot is guarded by an RWMutex for concurrent reads.
package store

import (
	"strings"
	"sync"
	"time"

	"github.com/nutanix/msp-pipeline-dashboard/internal/config"
	"github.com/nutanix/msp-pipeline-dashboard/internal/discovery"
	"github.com/nutanix/msp-pipeline-dashboard/internal/jenkins"
	"github.com/nutanix/msp-pipeline-dashboard/internal/model"
)

// AlertSender posts a failure alert; injected to avoid an import cycle with slack.
// It receives the alert entry and returns an opaque outcome for the ledger.
type AlertSender func(model.Alert) any

// alertSender is the wired failure-alert function (nil = alerting disabled).

var (
	mu       sync.RWMutex
	snapshot = model.Snapshot{
		Static:        []model.Card{},
		Masters:       []model.VersionBlock{},
		VersionBlocks: []model.VersionBlock{},
		Alerts:        []model.Alert{},
	}

	discMu          sync.Mutex
	cachedDiscovery *discovery.Result
	lastDiscoveryAt time.Time

	alertSender AlertSender
)

// SetAlertSender wires the slack failure-alert function.
func SetAlertSender(fn AlertSender) { alertSender = fn }

// normalizeStatus maps a Jenkins build result+building into our vocabulary.
func normalizeStatus(b *jenkins.RawBuild) string {
	if b == nil {
		return "unknown"
	}
	if b.Building {
		return "running"
	}
	switch b.Result {
	case "SUCCESS":
		return "success"
	case "FAILURE":
		return "failed"
	case "UNSTABLE":
		return "unstable"
	case "ABORTED":
		return "aborted"
	case "":
		return "running"
	default:
		return strings.ToLower(b.Result)
	}
}

// toPipelineCard turns a raw Jenkins job into a normalized card.
func toPipelineCard(meta discovery.Meta, res jenkins.JobResult) model.Card {
	cat := meta.Category
	if cat == "" {
		cat = "pipeline"
	}
	base := model.Card{
		Key:             meta.Key,
		Title:           meta.Title,
		Subtitle:        meta.Subtitle,
		Lane:            model.Ptr(meta.Lane),
		Version:         model.Ptr(meta.Version),
		Controller:      meta.Controller,
		MasterGroup:     model.Ptr(meta.MasterGroup),
		SynthesizedFrom: model.Ptr(meta.SynthesizedFrom),
		URL:             jenkins.JobWebURL(meta.Controller, meta.Path),
		Category:        cat,
	}

	if !res.OK || res.Data == nil {
		base.Status = "unreachable"
		base.Reachable = false
		base.Error = res.Error
		if base.Error == "" {
			base.Error = "no data"
		}
		base.Builds = []model.Build{}
		base.LastBuildNumber = nil
		base.Health = nil
		base.SuccessRate = nil
		base.ConsecutiveFailures = 0
		return base
	}

	data := res.Data
	builds := make([]model.Build, 0, len(data.Builds))
	for _, b := range data.Builds {
		bb := b
		builds = append(builds, model.Build{
			Number:    b.Number,
			Status:    normalizeStatus(&bb),
			Result:    model.Ptr(b.Result),
			Building:  b.Building,
			Timestamp: b.Timestamp,
			Duration:  b.Duration,
			URL:       b.URL,
		})
	}

	status := "unknown"
	var lastNum *int
	var lastTs int64
	if len(builds) > 0 {
		status = builds[0].Status
		n := builds[0].Number
		lastNum = &n
		lastTs = builds[0].Timestamp
	}

	// Completed builds only for success-rate + consecutive-failure math.
	done := completedBuilds(builds)
	completed := len(done)
	successCount := 0
	for _, b := range done {
		if b.Status == "success" {
			successCount++
		}
	}
	var successRate *int
	if completed > 0 {
		r := int(float64(successCount)/float64(completed)*100 + 0.5)
		successRate = &r
	}

	consec, consecOK, allFailing := computeStreaks(done, config.Setting.BuildsToTrack)

	var health *model.Health
	if len(data.HealthReport) > 0 {
		health = &model.Health{Score: data.HealthReport[0].Score, Description: data.HealthReport[0].Description}
	}

	base.Status = status
	base.Reachable = true
	base.Builds = builds
	base.LastBuildNumber = lastNum
	base.LastTimestamp = lastTs
	base.Health = health
	base.SuccessRate = successRate
	base.CompletedCount = completed
	base.ConsecutiveFailures = consec
	base.ConsecutiveSuccesses = consecOK
	base.AllFailing = allFailing
	return base
}

func completedBuilds(builds []model.Build) []model.Build {
	out := make([]model.Build, 0, len(builds))
	for _, b := range builds {
		if b.Status != "running" {
			out = append(out, b)
		}
	}
	return out
}

func latestCompleted(builds []model.Build) *model.Build {
	for i := range builds {
		if builds[i].Status != "running" {
			b := builds[i]
			return &b
		}
	}
	return nil
}

// computeStreaks counts authentic Jenkins FAILURE streaks from newest
// completed build backwards. aborted/unstable do not count as failures
// and break the streak. allFailing is true only when the last `track`
// completed builds are all FAILURE (in-flight builds must not inflate
// the window).
func computeStreaks(completed []model.Build, track int) (consecFail, consecOK int, allFailing bool) {
	for _, b := range completed {
		if b.Status == "failed" {
			consecFail++
		} else {
			break
		}
	}
	for _, b := range completed {
		if b.Status == "success" {
			consecOK++
		} else {
			break
		}
	}
	if track > 0 && len(completed) >= track {
		allFailing = true
		for i := 0; i < track; i++ {
			if completed[i].Status != "failed" {
				allFailing = false
				break
			}
		}
	}
	return
}

// failLane picks which consecutive-failure threshold applies.
type failLane int

const (
	failLaneMaster failLane = iota
	failLanePatch
	failLaneDevtest
)

func failLaneOf(key string, masterKeys, devtestKeys map[string]struct{}) failLane {
	if _, ok := masterKeys[key]; ok {
		return failLaneMaster
	}
	if _, ok := devtestKeys[key]; ok {
		return failLaneDevtest
	}
	return failLanePatch
}

func thresholdFor(lane failLane) (n int, ok bool) {
	switch lane {
	case failLaneDevtest:
		return config.Setting.DevtestFailThreshold, true
	case failLanePatch:
		return config.Setting.PatchFailThreshold, true
	default:
		return 0, false
	}
}

// shouldFireFailureAlert is the Slack gate:
//  1. 10-in-a-row (allFailing) — any reachable pipeline
//  2. DEVTEST_FAIL_THRESHOLD — static Devtest
//  3. PATCH_FAIL_THRESHOLD — version-block (patch-release) lanes
//
// Master lanes stay on the scheduled digest so they are not double-pinged.
func shouldFireFailureAlert(card model.Card, lane failLane) bool {
	if !card.Reachable {
		return false
	}
	if card.AllFailing {
		return true
	}
	t, ok := thresholdFor(lane)
	return ok && card.ConsecutiveFailures >= t
}

// ensureDiscovery refreshes folder listing if stale (>30m) or forced.
func ensureDiscovery(force bool) discovery.Result {
	discMu.Lock()
	defer discMu.Unlock()
	stale := time.Since(lastDiscoveryAt) > 30*time.Minute
	if force || cachedDiscovery == nil || stale {
		d := discovery.DiscoverPipelines()
		cachedDiscovery = &d
		lastDiscoveryAt = time.Now()
	}
	return *cachedDiscovery
}

// buildFetchList assembles the metas to fetch (static + masters + versioned).
func buildFetchList(d discovery.Result) []discovery.Meta {
	list := []discovery.Meta{}
	for _, s := range config.StaticPipelines {
		list = append(list, discovery.Meta{
			Key: s.Key, Controller: s.Controller, Path: s.Path,
			Title: s.Title, Subtitle: s.Subtitle, Category: s.Category,
			Lane: s.Lane,
		})
	}
	list = append(list, d.Masters...)
	for _, v := range discovery.SortedVersions(d.Versions) {
		list = append(list, d.Versions[v]...)
	}
	return list
}

// masterBlockOrder is the UI row order for isMaster groups.
var masterBlockOrder = []string{"msp-master", "master"}

func masterGroupOf(m discovery.Meta) string {
	switch m.MasterGroup {
	case "", "lkg", "other":
		return "master"
	default:
		return m.MasterGroup
	}
}

// assembleVersionBlocks clubs master groups + patch releases per version.
// msp-master and product master stay as separate isMaster rows.
func assembleVersionBlocks(d discovery.Result, cardByKey map[string]model.Card) []model.VersionBlock {
	blocks := []model.VersionBlock{}

	grouped := map[string][]model.Card{}
	seen := map[string]bool{}
	for _, m := range d.Masters {
		c, ok := cardByKey[m.Key]
		if !ok {
			continue
		}
		g := masterGroupOf(m)
		grouped[g] = append(grouped[g], c)
		seen[g] = true
	}
	for _, g := range masterBlockOrder {
		if pipes := grouped[g]; len(pipes) > 0 {
			blocks = append(blocks, model.VersionBlock{
				Version: g, Train: g, IsMaster: true,
				Label: g, Pipelines: pipes,
			})
			delete(seen, g)
		}
	}
	for g := range seen {
		if pipes := grouped[g]; len(pipes) > 0 {
			blocks = append(blocks, model.VersionBlock{
				Version: g, Train: g, IsMaster: true,
				Label: g, Pipelines: pipes,
			})
		}
	}

	for _, version := range discovery.SortedVersions(d.Versions) {
		pipelines := []model.Card{}
		for _, p := range d.Versions[version] {
			if c, ok := cardByKey[p.Key]; ok {
				pipelines = append(pipelines, c)
			}
		}
		blocks = append(blocks, model.VersionBlock{
			Version: version, Train: discovery.TrainOf(version), IsMaster: false,
			Label: version, Pipelines: pipelines,
		})
	}
	return blocks
}

func computeStats(cards []model.Card) model.Stats {
	s := model.Stats{}
	for _, c := range cards {
		s.Total++
		switch c.Status {
		case "success":
			s.Success++
		case "failed", "aborted":
			s.Failed++
		case "running":
			s.Running++
		case "unstable":
			s.Unstable++
		case "unreachable":
			s.Unreachable++
		default:
			s.Unknown++
		}
	}
	return s
}

// Poll runs one full cycle and swaps the snapshot atomically.
func Poll(forceDiscovery bool) model.Snapshot {
	d := ensureDiscovery(forceDiscovery)
	metas := buildFetchList(d)

	type pair struct {
		meta discovery.Meta
		card model.Card
	}
	pairs := jenkins.MapLimit(metas, config.Setting.Concurrency, func(m discovery.Meta) pair {
		res := jenkins.FetchJob(m.Controller, m.Path, config.Setting.BuildsToTrack)
		return pair{meta: m, card: toPipelineCard(m, res)}
	})

	cardByKey := make(map[string]model.Card, len(pairs))
	allCards := make([]model.Card, 0, len(pairs))
	for _, p := range pairs {
		cardByKey[p.meta.Key] = p.card
		allCards = append(allCards, p.card)
	}

	staticCards := []model.Card{}
	for _, s := range config.StaticPipelines {
		if c, ok := cardByKey[s.Key]; ok {
			staticCards = append(staticCards, c)
		}
	}

	versionBlocks := assembleVersionBlocks(d, cardByKey)

	masterKeys := map[string]struct{}{}
	for _, b := range versionBlocks {
		if !b.IsMaster {
			continue
		}
		for _, c := range b.Pipelines {
			masterKeys[c.Key] = struct{}{}
		}
	}
	devtestKeys := map[string]struct{}{}
	for _, s := range config.StaticPipelines {
		devtestKeys[s.Key] = struct{}{}
	}

	// Alerting:
	//  1) per-pipeline: last N completed builds are all FAILURE (allFailing).
	//  2) DEVTEST_FAIL_THRESHOLD / PATCH_FAIL_THRESHOLD for those lanes.
	//     Slack text uses the observed streak (not BuildsToTrack).
	alerts := []model.Alert{}
	for _, card := range allCards {
		if !shouldFireFailureAlert(card, failLaneOf(card.Key, masterKeys, devtestKeys)) {
			continue
		}
		lastNum := card.LastBuildNumber
		lastResult := ""
		if lb := latestCompleted(card.Builds); lb != nil {
			n := lb.Number
			lastNum = &n
			lastResult = model.Deref(lb.Result)
			if lastResult == "" {
				lastResult = strings.ToUpper(lb.Status)
			}
		}
		entry := model.Alert{
			Key: card.Key, Title: card.Title, Lane: model.Deref(card.Lane), Version: model.Deref(card.Version),
			URL: card.URL, Window: card.ConsecutiveFailures,
			LastBuildNumber: lastNum, LastResult: lastResult,
			At: time.Now().UnixMilli(),
		}
		if alertSender != nil {
			entry.Outcome = alertSender(entry)
		}
		alerts = append(alerts, entry)
	}

	discErrs := make([]model.DiscoveryError, 0, len(d.ErrorList))
	for _, e := range d.ErrorList {
		discErrs = append(discErrs, model.DiscoveryError{Rule: e.Rule, Error: e.Error})
	}

	masters := []model.VersionBlock{}
	for _, b := range versionBlocks {
		if b.IsMaster {
			masters = append(masters, b)
		}
	}

	snap := model.Snapshot{
		GeneratedAt:     time.Now().UnixMilli(),
		Polling:         false,
		Static:          staticCards,
		Masters:         masters,
		VersionBlocks:   versionBlocks,
		DiscoveryErrors: discErrs,
		DiscoveredAt:    d.DiscoveredAt,
		Stats:           computeStats(allCards),
		Alerts:          alerts,
	}

	mu.Lock()
	snapshot = snap
	mu.Unlock()
	return snap
}

// GetSnapshot returns the current snapshot (safe for concurrent readers).
func GetSnapshot() model.Snapshot {
	mu.RLock()
	defer mu.RUnlock()
	return snapshot
}

// GetMasterFailures returns master-block cards with consecutiveFailures >= threshold,
// worst-first. "Master" = every pipeline in blocks flagged isMaster.
func GetMasterFailures(threshold int) []model.Card {
	if threshold < 1 {
		threshold = 1
	}
	mu.RLock()
	blocks := snapshot.VersionBlocks
	mu.RUnlock()

	failing := []model.Card{}
	for _, block := range blocks {
		if !block.IsMaster {
			continue
		}
		for _, card := range block.Pipelines {
			if card.ConsecutiveFailures >= threshold {
				failing = append(failing, card)
			}
		}
	}
	// worst-first
	for i := 0; i < len(failing); i++ {
		for j := i + 1; j < len(failing); j++ {
			if failing[j].ConsecutiveFailures > failing[i].ConsecutiveFailures {
				failing[i], failing[j] = failing[j], failing[i]
			}
		}
	}
	return failing
}

// GetPatchFailures returns version-block (non-master) pipelines with
// consecutiveFailures >= PATCH_FAIL_THRESHOLD, worst-first.
func GetPatchFailures() []model.Card {
	threshold := config.Setting.PatchFailThreshold
	if threshold < 1 {
		threshold = 1
	}
	mu.RLock()
	blocks := snapshot.VersionBlocks
	mu.RUnlock()

	failing := []model.Card{}
	for _, block := range blocks {
		if block.IsMaster {
			continue
		}
		for _, card := range block.Pipelines {
			if card.ConsecutiveFailures >= threshold {
				failing = append(failing, card)
			}
		}
	}
	// worst-first
	for i := 0; i < len(failing); i++ {
		for j := i + 1; j < len(failing); j++ {
			if failing[j].ConsecutiveFailures > failing[i].ConsecutiveFailures {
				failing[i], failing[j] = failing[j], failing[i]
			}
		}
	}
	return failing
}

// GetDevtestFailures returns static Devtest cards with consecutiveFailures >=
// DEVTEST_FAIL_THRESHOLD, worst-first.
func GetDevtestFailures() []model.Card {
	threshold := config.Setting.DevtestFailThreshold
	if threshold < 1 {
		threshold = 1
	}
	mu.RLock()
	staticCards := snapshot.Static
	mu.RUnlock()

	failing := []model.Card{}
	for _, card := range staticCards {
		if card.ConsecutiveFailures >= threshold {
			failing = append(failing, card)
		}
	}
	for i := 0; i < len(failing); i++ {
		for j := i + 1; j < len(failing); j++ {
			if failing[j].ConsecutiveFailures > failing[i].ConsecutiveFailures {
				failing[i], failing[j] = failing[j], failing[i]
			}
		}
	}
	return failing
}

// GetMasterSuccesses returns master-block cards with consecutiveSuccesses >=
// threshold, best-first. Used by the optional success digest.
func GetMasterSuccesses(threshold int) []model.Card {
	if threshold < 1 {
		threshold = 1
	}
	mu.RLock()
	blocks := snapshot.VersionBlocks
	mu.RUnlock()

	ok := []model.Card{}
	for _, block := range blocks {
		if !block.IsMaster {
			continue
		}
		for _, card := range block.Pipelines {
			if card.ConsecutiveSuccesses >= threshold {
				ok = append(ok, card)
			}
		}
	}
	for i := 0; i < len(ok); i++ {
		for j := i + 1; j < len(ok); j++ {
			if ok[j].ConsecutiveSuccesses > ok[i].ConsecutiveSuccesses {
				ok[i], ok[j] = ok[j], ok[i]
			}
		}
	}
	return ok
}
