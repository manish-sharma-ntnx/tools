// Package scheduler fires the master-pipeline digest at configured wall-clock
// times in named IANA timezones (DST-aware via time.LoadLocation).
// Ported from server/scheduler.js.
package scheduler

import (
	"fmt"
	"log"
	"time"

	"github.com/nutanix/msp-pipeline-dashboard/internal/config"
	"github.com/nutanix/msp-pipeline-dashboard/internal/slack"
	"github.com/nutanix/msp-pipeline-dashboard/internal/store"
)

// nextOccurrence returns the next time hour:minute occurs in tz (today or tomorrow).
func nextOccurrence(hour, minute int, tz string) time.Time {
	loc, err := time.LoadLocation(tz)
	if err != nil {
		log.Printf("[digest] unknown timezone %q, falling back to UTC: %v", tz, err)
		loc = time.UTC
	}
	now := time.Now().In(loc)
	target := time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, loc)
	if !target.After(now.Add(time.Second)) {
		target = target.Add(24 * time.Hour)
	}
	return target
}

// FireDigest evaluates the threshold and posts if anything qualifies.
func FireDigest(label string) slack.Outcome {
	failing := store.GetMasterFailures(config.MasterDigest.FailThreshold)
	if len(failing) == 0 {
		log.Printf("[digest] (%s) no master pipeline at >= %d consecutive failures; nothing to post.",
			label, config.MasterDigest.FailThreshold)
		return slack.Outcome{Sent: false, Skipped: true, Reason: "nothing-failing"}
	}
	outcome := slack.PostMasterDigest(failing, slack.DigestMeta{
		Threshold: config.MasterDigest.FailThreshold,
		When:      label,
	})
	status := "SENT"
	if !outcome.Sent {
		status = fmt.Sprintf("NOT sent (%s)", outcome.Reason)
	}
	log.Printf("[digest] (%s) %d failing master pipeline(s) -> post %s to %s",
		label, len(failing), status, config.MasterDigest.Channel)
	return outcome
}

// FireDigestTest always attempts a Slack post so operators can verify the
// channel: the normal failure digest if anything qualifies, otherwise an
// all-clear / connectivity message.
func FireDigestTest() slack.Outcome {
	failing := store.GetMasterFailures(config.MasterDigest.FailThreshold)
	meta := slack.DigestMeta{Threshold: config.MasterDigest.FailThreshold, When: "manual-test", TestMode: true}
	if len(failing) == 0 {
		outcome := slack.PostAllClear(meta)
		if outcome.Sent && outcome.Reason == "" {
			outcome.Reason = "all-clear"
		}
		status := "SENT"
		if !outcome.Sent {
			status = fmt.Sprintf("NOT sent (%s)", outcome.Reason)
		}
		log.Printf("[digest] (manual-test) all-clear -> post %s to %s", status, config.MasterDigest.Channel)
		return outcome
	}
	return FireDigest("manual-test")
}

// armSlot schedules a repeating daily timer for one { hour, minute, tz } slot.
func armSlot(slot config.DigestTime) {
	label := fmt.Sprintf("%02d:%02d %s", slot.Hour, slot.Minute, slot.TZ)
	var schedule func()
	schedule = func() {
		next := nextOccurrence(slot.Hour, slot.Minute, slot.TZ)
		delay := time.Until(next)
		log.Printf("[digest] next post for %s in %.2fh (~%s)", label, delay.Hours(), next.UTC().Format(time.RFC3339))
		time.AfterFunc(delay, func() {
			func() {
				defer func() {
					if r := recover(); r != nil {
						log.Printf("[digest] (%s) failed: %v", label, r)
					}
				}()
				FireDigest(label)
			}()
			schedule() // re-arm for the next day
		})
	}
	schedule()
}

// Start launches the master-digest scheduler. Safe no-op when disabled.
func Start() {
	if !config.MasterDigest.Enabled {
		log.Printf("[digest] master digest disabled (MASTER_DIGEST_ENABLED=false).")
		return
	}
	if !config.Slack.Enabled {
		log.Printf("[digest] Slack posting paused (SLACK_ENABLED=false). Digest will run but never post.")
	} else if config.Slack.BotToken == "" {
		log.Printf("[digest] SLACK_BOT_TOKEN not set — digest will run but only LOG (never post). Set the bot token to enable posting.")
	} else {
		a := slack.VerifyAuth()
		if a.OK {
			log.Printf("[digest] Slack bot authenticated as %s (team %s).", a.User, a.Team)
		} else {
			log.Printf("[digest] Slack auth.test failed: %s. Posting will fail.", a.Error)
		}
	}
	if len(config.MasterDigest.Times) == 0 {
		log.Printf("[digest] no MASTER_DIGEST_TIMES configured; scheduler idle.")
		return
	}
	for _, slot := range config.MasterDigest.Times {
		armSlot(slot)
	}
}
