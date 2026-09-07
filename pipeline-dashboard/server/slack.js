'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const { SLACK, MASTER_DIGEST, SETTINGS, dashboardUrl } = require('./config');

const STATE_FILE = path.join(SETTINGS.dataDir, 'alert-state.json');

// Cap stored timestamps per pipeline so the state file stays bounded.
const MAX_TIMESTAMPS_PER_PIPELINE = 200;

function loadState() {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    state = {};
  }
  if (!state || typeof state !== 'object') state = {};
  if (!state.lastAlertAt) state.lastAlertAt = {};
  if (!state.history) state.history = {};
  return state;
}

/**
 * Record a fired-alert event for a pipeline (mutates `state`, caller persists).
 * History entry: { key, title, lane, version, url, count, firstAt, lastAt, timestamps[] }.
 */
function recordHistory(state, entry, now) {
  let h = state.history[entry.key];
  if (!h) {
    h = { key: entry.key, firstAt: now, count: 0, timestamps: [] };
    state.history[entry.key] = h;
  }
  h.title = entry.title;
  h.lane = entry.lane;
  h.version = entry.version;
  h.url = entry.url;
  h.count += 1;
  h.lastAt = now;
  h.timestamps.push(now);
  if (h.timestamps.length > MAX_TIMESTAMPS_PER_PIPELINE) {
    h.timestamps = h.timestamps.slice(-MAX_TIMESTAMPS_PER_PIPELINE);
  }
}

/** Return a copy of the per-pipeline alert history, newest-alert-first. */
function getAlertHistory() {
  const state = loadState();
  return Object.values(state.history)
    .map((h) => ({ ...h, timestamps: [...(h.timestamps || [])] }))
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}

function saveState(state) {
  try {
    fs.mkdirSync(SETTINGS.dataDir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[slack] failed to persist alert state:', e.message);
  }
}

function postJson(url, headers, payload) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const body = JSON.stringify(payload);
    const req = https.request(
      u,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...headers,
        },
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ status: 0, body: err.message }));
    req.write(body);
    req.end();
  });
}

/** Build the alert text + Block Kit for a failing pipeline (Jenkins + dashboard). */
function buildMessage(entry) {
  const dashUrl = dashboardUrl();
  const buildNo = entry.lastBuildNumber != null ? `#${entry.lastBuildNumber}` : '—';
  const lines = [
    `:rotating_light: *MSP Pipeline Alert* ${SLACK.mention}`,
    `*${entry.title}* has *failed the last ${entry.window} consecutive builds*.`,
    entry.version && entry.version !== 'master' ? `Version: \`${entry.version}\`` : null,
    `Lane: \`${entry.lane}\``,
    `Latest build: ${buildNo} — ${entry.lastResult}`,
    entry.url ? `<${entry.url}|Open in Jenkins>` : null,
    dashUrl ? `Dashboard: ${dashUrl}` : null,
  ].filter(Boolean);

  const detail = [
    entry.version && entry.version !== 'master' ? `Version: \`${entry.version}\`` : null,
    `Lane: \`${entry.lane}\``,
    `Latest build: ${buildNo} — ${entry.lastResult}`,
    entry.url ? `<${entry.url}|Jenkins>` : null,
  ].filter(Boolean);

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'MSP Pipeline Alert', emoji: true } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${entry.title}* has *failed the last ${entry.window} consecutive builds*.`,
      },
    },
    { type: 'section', text: { type: 'mrkdwn', text: detail.join('\n') } },
    dashUrl
      ? { type: 'section', text: { type: 'mrkdwn', text: `:bar_chart: <${dashUrl}|Open MSP Pipeline Dashboard>` } }
      : null,
    { type: 'context', elements: [{ type: 'mrkdwn', text: SLACK.mention }] },
  ].filter(Boolean);

  return { text: lines.join('\n'), blocks };
}

/**
 * Send an alert for a fully-failing pipeline, honoring cooldown so we don't spam.
 * `entry` = { key, title, lane, version, url, window, lastBuildNumber, lastResult }
 * Returns { sent, skipped, reason }.
 */
async function sendFailureAlert(entry) {
  if (!SLACK.enabled) {
    console.warn(`[slack] (SLACK_ENABLED=false) would alert -> ${SLACK.channel}: ${entry.title}`);
    return { sent: false, skipped: true, reason: 'disabled' };
  }
  const state = loadState();
  const now = Date.now();
  const last = state.lastAlertAt[entry.key] || 0;
  if (now - last < SLACK.cooldownMs) {
    return { sent: false, skipped: true, reason: 'cooldown' };
  }

  // The alert fires now: persist cooldown stamp + history regardless of whether
  // a Slack transport is configured, so the Alerts tab reflects real events.
  state.lastAlertAt[entry.key] = now;
  recordHistory(state, entry, now);
  saveState(state);

  const { text, blocks } = buildMessage(entry);
  let result;

  if (SLACK.webhookUrl) {
    result = await postJson(SLACK.webhookUrl, {}, { channel: SLACK.channel, text, blocks });
  } else if (SLACK.botToken) {
    result = await postJson(
      'https://slack.com/api/chat.postMessage',
      { Authorization: `Bearer ${SLACK.botToken}` },
      { channel: SLACK.channel, text, link_names: true, blocks }
    );
  } else {
    // No transport configured: log so the alert is not silently lost.
    console.warn(`[slack] (not configured) would alert -> ${SLACK.channel}:\n${text}`);
    return { sent: false, skipped: true, reason: 'no-transport' };
  }

  const ok = result.status >= 200 && result.status < 300 && !/\"ok\":false/.test(result.body || '');
  if (ok) {
    return { sent: true, skipped: false };
  }
  console.error(`[slack] send failed status=${result.status} body=${result.body}`);
  return { sent: false, skipped: false, reason: `http ${result.status}` };
}

/* ------------------------------------------------------------------ *
 *  Bot-token posting (chat.postMessage) + master-status digest
 * ------------------------------------------------------------------ */

/** Verify the configured bot token with auth.test. Returns { ok, user, team, error }. */
async function verifyAuth() {
  if (!SLACK.botToken) return { ok: false, error: 'no-bot-token' };
  const res = await postJson(
    'https://slack.com/api/auth.test',
    { Authorization: `Bearer ${SLACK.botToken}` },
    {}
  );
  let parsed = {};
  try {
    parsed = JSON.parse(res.body || '{}');
  } catch {
    parsed = {};
  }
  return { ok: !!parsed.ok, user: parsed.user, team: parsed.team, error: parsed.error };
}

/**
 * Post a message to a channel via the bot token (chat.postMessage).
 * `text` is the fallback/notification text; `blocks` is optional Block Kit.
 */
async function postMessage(channel, text, blocks) {
  if (!SLACK.enabled) {
    console.warn(`[slack] (SLACK_ENABLED=false) would post -> ${channel}:\n${text}`);
    return { sent: false, skipped: true, reason: 'disabled' };
  }
  if (!SLACK.botToken) {
    console.warn(`[slack] (no SLACK_BOT_TOKEN) would post -> ${channel}:\n${text}`);
    return { sent: false, skipped: true, reason: 'no-bot-token' };
  }
  const payload = { channel, text, link_names: true };
  if (blocks) payload.blocks = blocks;
  const result = await postJson(
    'https://slack.com/api/chat.postMessage',
    { Authorization: `Bearer ${SLACK.botToken}` },
    payload
  );
  const ok =
    result.status >= 200 && result.status < 300 && !/"ok"\s*:\s*false/.test(result.body || '');
  if (!ok) {
    let slackErr = '';
    try {
      slackErr = JSON.parse(result.body || '{}').error || '';
    } catch (_) {
      slackErr = '';
    }
    const reason = slackErr || (result.body && result.status === 0 ? result.body : `http ${result.status}`);
    console.error(`[slack] postMessage failed ${reason} body=${result.body}`);
    return { sent: false, skipped: false, reason };
  }
  return { sent: true, skipped: false };
}

const STATUS_EMOJI = {
  success: ':large_green_circle:',
  failed: ':red_circle:',
  aborted: ':black_circle:',
  unstable: ':large_yellow_circle:',
  running: ':arrows_counterclockwise:',
  unreachable: ':warning:',
  unknown: ':white_circle:',
};

/** Build the Block Kit payload for the master-failure digest. */
function buildMasterDigest(failing, meta = {}) {
  const threshold = meta.threshold || MASTER_DIGEST.failThreshold;
  const header = `:rotating_light: MSP Master Pipeline Alert — ${failing.length} pipeline(s) failing ≥ ${threshold} builds`;

  const lines = failing.map((c) => {
    const emoji = STATUS_EMOJI[c.status] || STATUS_EMOJI.unknown;
    const lane = c.lane ? ` _(${c.lane})_` : '';
    const buildNo = c.lastBuildNumber != null ? `#${c.lastBuildNumber}` : 'n/a';
    const link = c.url ? `<${c.url}|Jenkins>` : '';
    return `${emoji} *${c.title}*${lane} — ${c.consecutiveFailures} consecutive failures, latest ${buildNo} ${link}`.trim();
  });

  const dashUrl = meta.dashboardUrl || dashboardUrl();
  const dashLink = dashUrl ? `<${dashUrl}|Open MSP Pipeline Dashboard>` : '';

  const text = `${header}\n${lines.join('\n')}${dashUrl ? `\nDashboard: ${dashUrl}` : ''}`;
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'MSP Master Pipeline Alert', emoji: true } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${failing.length} master pipeline(s) have failed *≥ ${threshold} consecutive builds*.`,
      },
    },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    dashLink
      ? { type: 'section', text: { type: 'mrkdwn', text: `:bar_chart: ${dashLink}` } }
      : null,
     {
       type: 'context',
       elements: [
         {
           type: 'mrkdwn',
           text: `Digest @ ${meta.when || new Date().toISOString()} • ${meta.test ? '' : SLACK.mention}`,
         },
       ],
     },
   ].filter(Boolean);
   return { text, blocks };
}

/**
 * Post the master-failure digest for the given failing pipelines.
 * `failing` = array of pipeline cards (already filtered to master + >=threshold).
 * If empty, nothing is posted. In test mode, posts to #test-msp and omits the
 * @msp-help mention. Returns { sent, skipped, reason }.
 */
async function postMasterDigest(failing, meta = {}) {
  if (!failing || failing.length === 0) {
    return { sent: false, skipped: true, reason: 'nothing-failing' };
  }
  const { text, blocks } = buildMasterDigest(failing, meta);
  const channel = meta.test ? '#test-msp' : MASTER_DIGEST.channel;
  return postMessage(channel, text, blocks);
}

function buildAllClear(meta = {}) {
  const threshold = meta.threshold || MASTER_DIGEST.failThreshold;
  const dashUrl = meta.dashboardUrl || dashboardUrl();
  const when = meta.when || new Date().toISOString();
  // In test mode, suppress the @msp-help mention so the verification post does
  // not ping the live channel.
  const mention = meta.test ? '' : SLACK.mention;
  const headerMention = mention ? ` • ${mention}` : '';
  const text = `:white_check_mark: MSP Master Pipeline Digest — all clear\nNo master pipeline is failing ≥ ${threshold} consecutive builds.${
    dashUrl ? `\nDashboard: ${dashUrl}` : ''
  }`;
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'MSP Master Pipeline Digest', emoji: true } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:white_check_mark: All clear — no master pipeline is failing *≥ ${threshold} consecutive builds*.`,
      },
    },
    dashUrl
      ? { type: 'section', text: { type: 'mrkdwn', text: `:bar_chart: <${dashUrl}|Open MSP Pipeline Dashboard>` } }
      : null,
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Test post @ ${when}${headerMention}` }],
    },
  ].filter(Boolean);
  return { text, blocks };
}

async function postAllClear(meta = {}) {
  const { text, blocks } = buildAllClear(meta);
  const channel = meta.test ? '#test-msp' : MASTER_DIGEST.channel;
  return postMessage(channel, text, blocks);
}

module.exports = {
  sendFailureAlert,
  getAlertHistory,
  buildMessage,
  postMessage,
  verifyAuth,
  buildMasterDigest,
  postMasterDigest,
  postAllClear,
};
