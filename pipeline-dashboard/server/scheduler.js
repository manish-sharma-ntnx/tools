'use strict';

/**
 * Timezone-aware daily scheduler for the master-pipeline digest.
 *
 * Fires a callback at specific wall-clock times in named IANA timezones
 * (e.g. 09:00 Asia/Kolkata and 09:00 America/Los_Angeles), correctly handling
 * DST because it derives the target instant from the zone's *current* offset.
 *
 * No cron daemon and no third-party deps — pure setTimeout re-armed after each
 * fire. Ideal for the zero-dependency deployment model of this app.
 */

const { MASTER_DIGEST, SLACK } = require('./config');
const store = require('./store');
const { postMasterDigest, verifyAuth } = require('./slack');

/** Get the parts of "now" in a given IANA timezone as numbers. */
function nowInZone(tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date())) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  // en-US formats midnight hour as 24; normalize to 0.
  if (parts.hour === 24) parts.hour = 0;
  return parts;
}

/**
 * Compute ms until the next occurrence of hour:minute in `tz`.
 * Works by measuring the offset between the zone's wall clock and UTC "now",
 * then projecting the target wall-clock instant into real (UTC) time.
 */
function msUntilNext(hour, minute, tz) {
  const now = new Date();
  const z = nowInZone(tz);

  // The zone's current wall-clock time as a UTC-epoch reference.
  const zoneNowUTC = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  // The zone's offset from UTC right now (ms). e.g. IST = +5:30.
  const offset = zoneNowUTC - now.getTime();

  // Target wall-clock time today in the zone, expressed as the same UTC-epoch basis.
  let targetZoneUTC = Date.UTC(z.year, z.month - 1, z.day, hour, minute, 0);
  // Convert that wall-clock target into a real instant by removing the offset.
  let targetReal = targetZoneUTC - offset;

  // If it already passed (or is within 1s), schedule for tomorrow.
  if (targetReal <= now.getTime() + 1000) {
    targetReal += 24 * 60 * 60 * 1000;
  }
  return targetReal - now.getTime();
}

async function fireDigest(label) {
  const failing = store.getMasterFailures(MASTER_DIGEST.failThreshold);
  if (!failing.length) {
    console.log(
      `[digest] (${label}) no master pipeline at >= ${MASTER_DIGEST.failThreshold} consecutive failures; nothing to post.`
    );
    return;
  }
  const outcome = await postMasterDigest(failing, {
    threshold: MASTER_DIGEST.failThreshold,
    when: label,
  });
  console.log(
    `[digest] (${label}) ${failing.length} failing master pipeline(s) -> post ${
      outcome.sent ? 'SENT' : `NOT sent (${outcome.reason})`
    } to ${MASTER_DIGEST.channel}`
  );
}

/** Arm one repeating daily timer for a single { hour, minute, tz } slot. */
function armSlot(slot) {
  const label = `${String(slot.hour).padStart(2, '0')}:${String(slot.minute).padStart(2, '0')} ${slot.tz}`;
  const schedule = () => {
    const delay = msUntilNext(slot.hour, slot.minute, slot.tz);
    const when = new Date(Date.now() + delay).toISOString();
    console.log(`[digest] next post for ${label} in ${(delay / 3600000).toFixed(2)}h (~${when})`);
    setTimeout(async () => {
      try {
        await fireDigest(label);
      } catch (e) {
        console.error(`[digest] (${label}) failed:`, e.message);
      } finally {
        schedule(); // re-arm for the next day
      }
    }, delay).unref?.();
  };
  schedule();
}

/** Start the master-digest scheduler. Safe no-op when disabled. */
function startMasterDigest() {
  if (!MASTER_DIGEST.enabled) {
    console.log('[digest] master digest disabled (MASTER_DIGEST_ENABLED=false).');
    return;
  }
  if (!SLACK.botToken) {
    console.warn(
      '[digest] SLACK_BOT_TOKEN not set — digest will run but only LOG (never post). Set the bot token to enable posting.'
    );
  } else {
    verifyAuth()
      .then((a) =>
        a.ok
          ? console.log(`[digest] Slack bot authenticated as ${a.user} (team ${a.team}).`)
          : console.error(`[digest] Slack auth.test failed: ${a.error}. Posting will fail.`)
      )
      .catch(() => {});
  }
  if (!MASTER_DIGEST.times.length) {
    console.warn('[digest] no MASTER_DIGEST_TIMES configured; scheduler idle.');
    return;
  }
  for (const slot of MASTER_DIGEST.times) armSlot(slot);
}

module.exports = { startMasterDigest, fireDigest, msUntilNext };
