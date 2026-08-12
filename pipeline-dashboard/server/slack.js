'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const { SLACK, SETTINGS } = require('./config');

const STATE_FILE = path.join(SETTINGS.dataDir, 'alert-state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastAlertAt: {} };
  }
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

/** Build the alert message text for a failing pipeline. */
function buildMessage(entry) {
  const mention = SLACK.mention.startsWith('@')
    ? `<!subteam^${''}|${SLACK.mention}>`.includes('subteam^|')
      ? SLACK.mention // fallback plain text if no group id
      : SLACK.mention
    : SLACK.mention;

  const lines = [
    `:rotating_light: *MSP Pipeline Alert* ${SLACK.mention}`,
    `*${entry.title}* has *failed the last ${entry.window} consecutive builds*.`,
    entry.version && entry.version !== 'master' ? `Version: \`${entry.version}\`` : null,
    `Lane: \`${entry.lane}\``,
    `Latest build: #${entry.lastBuildNumber} — ${entry.lastResult}`,
    `<${entry.url}|Open in Jenkins>`,
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * Send an alert for a fully-failing pipeline, honoring cooldown so we don't spam.
 * `entry` = { key, title, lane, version, url, window, lastBuildNumber, lastResult }
 * Returns { sent, skipped, reason }.
 */
async function sendFailureAlert(entry) {
  const state = loadState();
  const now = Date.now();
  const last = state.lastAlertAt[entry.key] || 0;
  if (now - last < SLACK.cooldownMs) {
    return { sent: false, skipped: true, reason: 'cooldown' };
  }

  const text = buildMessage(entry);
  let result;

  if (SLACK.webhookUrl) {
    result = await postJson(SLACK.webhookUrl, {}, { channel: SLACK.channel, text });
  } else if (SLACK.botToken) {
    result = await postJson(
      'https://slack.com/api/chat.postMessage',
      { Authorization: `Bearer ${SLACK.botToken}` },
      { channel: SLACK.channel, text, link_names: true }
    );
  } else {
    // No transport configured: log so the alert is not silently lost.
    console.warn(`[slack] (not configured) would alert -> ${SLACK.channel}:\n${text}`);
    return { sent: false, skipped: true, reason: 'no-transport' };
  }

  const ok = result.status >= 200 && result.status < 300 && !/\"ok\":false/.test(result.body || '');
  if (ok) {
    state.lastAlertAt[entry.key] = now;
    saveState(state);
    return { sent: true, skipped: false };
  }
  console.error(`[slack] send failed status=${result.status} body=${result.body}`);
  return { sent: false, skipped: false, reason: `http ${result.status}` };
}

module.exports = { sendFailureAlert, buildMessage };
