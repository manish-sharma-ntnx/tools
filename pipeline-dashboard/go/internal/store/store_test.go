package store

import (
	"testing"

	"github.com/nutanix/msp-pipeline-dashboard/internal/config"
	"github.com/nutanix/msp-pipeline-dashboard/internal/discovery"
	"github.com/nutanix/msp-pipeline-dashboard/internal/model"
)

func statuses(ss ...string) []model.Build {
	out := make([]model.Build, len(ss))
	for i, s := range ss {
		out[i] = model.Build{Number: 1000 - i, Status: s}
	}
	return out
}

func TestComputeStreaks_DevtestThreeFailuresThenSuccess(t *testing.T) {
	// Live msp-controller-precommit shape that produced the false
	// "10 consecutive builds" Slack: 2 in-flight, 3 FAILURE, then SUCCESS.
	completed := completedBuilds(statuses(
		"running", "running",
		"failed", "failed", "failed",
		"success", "success",
		"failed", "failed", "failed",
	))
	fail, _, allFailing := computeStreaks(completed, 10)
	if fail != 3 {
		t.Fatalf("consecutiveFailures=%d, want 3", fail)
	}
	if allFailing {
		t.Fatal("must not claim 10 consecutive failures when build 9201 succeeded")
	}
}

func TestComputeStreaks_RunningDoesNotInflateAllFailing(t *testing.T) {
	// Old Go allFailing counted a running head toward the 10-window, so
	// 1 running + 9 FAILURE looked like allFailing.
	completed := completedBuilds(statuses(
		"running",
		"failed", "failed", "failed", "failed", "failed",
		"failed", "failed", "failed", "failed",
	))
	fail, _, allFailing := computeStreaks(completed, 10)
	if fail != 9 {
		t.Fatalf("consecutiveFailures=%d, want 9", fail)
	}
	if allFailing {
		t.Fatal("running + 9 failures is not 10 consecutive completed FAILURES")
	}
}

func TestComputeStreaks_TenCompletedFailures(t *testing.T) {
	var ss []string
	for i := 0; i < 10; i++ {
		ss = append(ss, "failed")
	}
	fail, _, allFailing := computeStreaks(completedBuilds(statuses(ss...)), 10)
	if fail != 10 {
		t.Fatalf("consecutiveFailures=%d, want 10", fail)
	}
	if !allFailing {
		t.Fatal("10 completed FAILURES must set allFailing")
	}
}

func TestComputeStreaks_AbortedDoesNotCountAsFailure(t *testing.T) {
	fail, _, allFailing := computeStreaks(completedBuilds(statuses("failed", "aborted", "failed")), 10)
	if fail != 1 {
		t.Fatalf("consecutiveFailures=%d, want 1 (aborted breaks the FAILURE streak)", fail)
	}
	if allFailing {
		t.Fatal("aborted in the window is not 10 consecutive FAILURES")
	}
}

func TestShouldFireFailureAlert_DevtestUsesDevtestThreshold(t *testing.T) {
	card := model.Card{Reachable: true, ConsecutiveFailures: 3, AllFailing: false}
	if !shouldFireFailureAlert(card, failLaneDevtest) {
		t.Fatal("Devtest must Slack-alert at DEVTEST_FAIL_THRESHOLD")
	}
	below := model.Card{Reachable: true, ConsecutiveFailures: 2, AllFailing: false}
	if shouldFireFailureAlert(below, failLaneDevtest) {
		t.Fatal("below DEVTEST_FAIL_THRESHOLD must not Slack-alert")
	}
}

func TestShouldFireFailureAlert_PatchUsesPatchThreshold(t *testing.T) {
	card := model.Card{Reachable: true, ConsecutiveFailures: 3, AllFailing: false}
	if !shouldFireFailureAlert(card, failLanePatch) {
		t.Fatal("a patch-release lane at PATCH_FAIL_THRESHOLD must alert")
	}
}

func TestShouldFireFailureAlert_TenInARowEvenForStatic(t *testing.T) {
	card := model.Card{Reachable: true, ConsecutiveFailures: 10, AllFailing: true}
	if !shouldFireFailureAlert(card, failLaneMaster) {
		t.Fatal("10-in-a-row must alert for Devtest / any pipeline")
	}
}

func TestShouldFireFailureAlert_MasterDigestNotPerPollAtFive(t *testing.T) {
	// Master lanes with 5 failures belong to the scheduled digest, not the
	// per-poll Slack path (failLaneMaster, allFailing=false).
	card := model.Card{Reachable: true, ConsecutiveFailures: 5, AllFailing: false}
	if shouldFireFailureAlert(card, failLaneMaster) {
		t.Fatal("master 5-streak must not fire the per-poll Slack alert")
	}
}

func TestShouldFireFailureAlert_UnreachableNeverAlerts(t *testing.T) {
	card := model.Card{Reachable: false, ConsecutiveFailures: 10, AllFailing: true}
	if shouldFireFailureAlert(card, failLanePatch) {
		t.Fatal("unreachable cards must not alert")
	}
}

func TestFailThresholdDefaults(t *testing.T) {
	if config.Setting.PatchFailThreshold != 3 {
		t.Fatalf("PATCH_FAIL_THRESHOLD default=%d, want 3", config.Setting.PatchFailThreshold)
	}
	if config.Setting.DevtestFailThreshold != 3 {
		t.Fatalf("DEVTEST_FAIL_THRESHOLD default=%d, want 3", config.Setting.DevtestFailThreshold)
	}
	if config.Setting.BuildsToTrack != 10 {
		t.Fatalf("BuildsToTrack=%d, want 10", config.Setting.BuildsToTrack)
	}
}

func TestAssembleVersionBlocksSplitsMspMasterAndMaster(t *testing.T) {
	d := discovery.Result{
		Masters: []discovery.Meta{
			{Key: "pre", MasterGroup: "msp-master", Lane: "Precommit"},
			{Key: "lkg-vp", MasterGroup: "msp-master", Lane: "LKG"},
			{Key: "smoke", MasterGroup: "master", Lane: "Smoke"},
			{Key: "lkg", MasterGroup: "master", Lane: "LKG"},
		},
	}
	cards := map[string]model.Card{
		"pre":    {Key: "pre"},
		"lkg-vp": {Key: "lkg-vp"},
		"smoke":  {Key: "smoke"},
		"lkg":    {Key: "lkg"},
	}
	blocks := assembleVersionBlocks(d, cards)
	if len(blocks) != 2 {
		t.Fatalf("blocks=%d, want 2 master rows", len(blocks))
	}
	if !blocks[0].IsMaster || blocks[0].Version != "msp-master" {
		t.Fatalf("first block=%s isMaster=%v, want msp-master", blocks[0].Version, blocks[0].IsMaster)
	}
	if !blocks[1].IsMaster || blocks[1].Version != "master" {
		t.Fatalf("second block=%s isMaster=%v, want master", blocks[1].Version, blocks[1].IsMaster)
	}
	if keysOf(blocks[0].Pipelines)[0] != "pre" || keysOf(blocks[0].Pipelines)[1] != "lkg-vp" {
		t.Fatalf("msp-master pipelines=%v", keysOf(blocks[0].Pipelines))
	}
	if keysOf(blocks[1].Pipelines)[0] != "smoke" || keysOf(blocks[1].Pipelines)[1] != "lkg" {
		t.Fatalf("master pipelines=%v", keysOf(blocks[1].Pipelines))
	}
}

func TestGetDevtestFailuresUsesOwnThreshold(t *testing.T) {
	mu.Lock()
	prev := snapshot
	snapshot = model.Snapshot{
		Static: []model.Card{
			{Key: "devtest-precommit", Title: "Devtest Precommit", ConsecutiveFailures: 3},
		},
		VersionBlocks: []model.VersionBlock{
			{IsMaster: true, Pipelines: []model.Card{
				{Key: "master-precommit", ConsecutiveFailures: 6},
			}},
			{IsMaster: false, Pipelines: []model.Card{
				{Key: "patch-lkg", Title: "LKG 7.7", ConsecutiveFailures: 4},
			}},
		},
	}
	mu.Unlock()
	t.Cleanup(func() {
		mu.Lock()
		snapshot = prev
		mu.Unlock()
	})

	dev := GetDevtestFailures()
	if len(dev) != 1 || dev[0].Key != "devtest-precommit" {
		t.Fatalf("GetDevtestFailures()=%v, want only devtest-precommit", keysOf(dev))
	}
	patch := GetPatchFailures()
	if len(patch) != 1 || patch[0].Key != "patch-lkg" {
		t.Fatalf("GetPatchFailures()=%v, want only patch-lkg", keysOf(patch))
	}
}

func keysOf(cards []model.Card) []string {
	out := make([]string, len(cards))
	for i, c := range cards {
		out[i] = c.Key
	}
	return out
}
