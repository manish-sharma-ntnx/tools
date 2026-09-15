'use strict';

/**
 * Central configuration for the MSP Pipeline Dashboard.
 *
 * Jenkins controllers are read-only (anonymous). Each controller exposes the
 * standard Jenkins JSON API (`/api/json`) which is what we consume.
 *
 * Versioning discovered from the live controllers:
 *   - SB prod Controller-2: `msp-master` plus older `msp-ganges-<version>`
 *     (e.g. 7.6) in LCC_NOS / LCC_Dial_Tests.
 *   - SB prod Controller-4: current patch Precommit PC (`msp-ganges-<ver>-pc`)
 *     and Local LCC (`msp-ganges-<ver>`, e.g. 7.6.1, 7.7).
 *   - SB prod Controller-1: LKG + Smoke (`ganges-<ver>-stable`).
 *   - Harbinger-12: older Precommit PC jobs still listed there.
 *
 * "version" here is the ganges train, e.g. 7.6, 7.6.0.1, 7.5.1.10.
 */

const CONTROLLERS = {
  devtest: {
    id: 'devtest',
    label: 'Devtest',
    baseUrl: 'http://10.37.10.188:8080',
    insecure: false,
  },
  sbprod1: {
    id: 'sbprod1',
    label: 'SB Prod Controller-1',
    baseUrl: 'https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com',
    insecure: true,
  },
  sbprod: {
    id: 'sbprod',
    label: 'SB Prod Controller-2',
    baseUrl: 'https://phx-p10y-sb-prod-jenkins-controller-2.corp.p10y.ntnxdpro.com',
    insecure: true, // internal cert
  },
  harbinger: {
    id: 'harbinger',
    label: 'Harbinger Prod-14',
    baseUrl: 'https://phx-p10y-jenkins-harbinger-prod-14.p10y.eng.nutanix.com',
    insecure: true,
  },
  harbinger12: {
    id: 'harbinger12',
    label: 'Harbinger Prod-12',
    baseUrl: 'https://phx-p10y-jenkins-harbinger-prod-12.p10y.eng.nutanix.com',
    insecure: true,
  },
  sbprod3: {
    id: 'sbprod3',
    label: 'SB Prod Controller-3',
    baseUrl: 'https://phx-p10y-sb-prod-jenkins-controller-3.corp.p10y.ntnxdpro.com',
    insecure: true,
  },
  sbprod4: {
    id: 'sbprod4',
    label: 'SB Prod Controller-4',
    baseUrl: 'https://phx-p10y-sb-prod-jenkins-controller-4.corp.p10y.ntnxdpro.com',
    insecure: true,
  },
};

/**
 * A "job path" is the list of Jenkins folder segments leading to a job.
 * The Jenkins URL for a job is: baseUrl + /job/<seg1>/job/<seg2>/.../job/<name>
 */

// Static (always present) pipelines that are NOT version-scoped.
const STATIC_PIPELINES = [
  {
    key: 'devtest-precommit',
    controller: 'devtest',
    path: ['msp-controller-precommit'],
    group: 'Devtest',
    category: 'devtest',
    lane: 'Precommit',
    title: 'Devtest Precommit',
    subtitle: 'msp-controller-precommit',
  },
];

/**
 * Discovery rules describe how to auto-find version-scoped pipelines.
 *
 * For each rule we list the parent folder, then a regex that captures the
 * version out of child job names. `masterName` marks the non-versioned master
 * job in the same folder so we can club master + patch under a version block.
 */
const DISCOVERY_RULES = [
  {
    id: 'lcc-local',
    controller: 'sbprod',
    parent: ['Nupipe', 'LCC_NOS'],
    label: 'msp_master Local LCC',
    shortLabel: 'Local LCC',
    lane: 'LCC',
    masterGroup: 'msp-master',
    masterName: 'msp-master',
    // msp-master + older patch (e.g. 7.6). Current trains (7.6.1, 7.7, …)
    // live on Controller-4 (lcc-local-c4) and upsert over this rule.
    versionRegex: /^msp-ganges-(\d+(?:\.\d+)*)$/,
    jobPrefix: 'msp-ganges-',
  },
  {
    id: 'glcc',
    controller: 'sbprod',
    parent: ['Nupipe', 'LCC_Dial_Tests'],
    label: 'msp_master GLCC',
    shortLabel: 'GLCC',
    lane: 'GLCC',
    masterGroup: 'msp-master',
    masterName: 'msp-master',
    // ignore the -pc siblings for the primary card (tracked separately if desired)
    versionRegex: /^msp-ganges-(\d+(?:\.\d+)*)$/,
    jobPrefix: 'msp-ganges-',
  },
  {
    // Precommit MASTER: a real msp-master job on SB Prod Controller-3. This is the
    // card shown under the msp-master group for the Precommit lane.
    id: 'precommit-master',
    controller: 'sbprod3',
    parent: ['Nupipe', 'Precommit_NOS'],
    label: 'msp Precommit',
    shortLabel: 'Precommit',
    lane: 'Precommit',
    masterGroup: 'msp-master',
    masterName: 'msp-master',
    // No version-scoped jobs consumed from here; master only.
    versionRegex: /^$/,
  },
  {
    // Older patch Precommit PC on Harbinger-12 (7.6, 7.6.0.x, 7.6.9.1–3).
    // Current trains moved to Controller-4; listed first so the later rule wins.
    id: 'precommit-pc',
    controller: 'harbinger12',
    parent: ['Nupipe', 'Precommit_PC'],
    label: 'msp Precommit PC',
    shortLabel: 'Precommit',
    lane: 'Precommit',
    masterName: null,
    // msp-ganges-7.6-pc | msp-ganges-7.6.9.3-pc  (exclude msp-feat-*, msp-ncm-*)
    versionRegex: /^msp-ganges-(\d+(?:\.\d+)*)-pc$/,
    jobPrefix: 'msp-ganges-',
    jobSuffix: '-pc',
  },
  {
    // Current patch Precommit PC (7.6.1, 7.7, …) on SB Prod Controller-4.
    id: 'precommit-pc-c4',
    controller: 'sbprod4',
    parent: ['Nupipe', 'Precommit_PC'],
    label: 'msp Precommit PC',
    shortLabel: 'Precommit',
    lane: 'Precommit',
    masterName: null,
    versionRegex: /^msp-ganges-(\d+(?:\.\d+)*)-pc$/,
    jobPrefix: 'msp-ganges-',
    jobSuffix: '-pc',
  },
  {
    // Current patch Local LCC (7.6.1, 7.7, …) on SB Prod Controller-4.
    // Master LCC stays on the sbprod (Controller-2) rule above.
    id: 'lcc-local-c4',
    controller: 'sbprod4',
    parent: ['Nupipe', 'LCC_NOS'],
    label: 'msp_master Local LCC',
    shortLabel: 'Local LCC',
    lane: 'LCC',
    masterGroup: 'msp-master',
    masterName: null,
    versionRegex: /^msp-ganges-(\d+(?:\.\d+)*)$/,
    jobPrefix: 'msp-ganges-',
  },
  {
    // Postcommit / smoke. Master job is on SB Prod Controller-1.
    id: 'smoke',
    controller: 'sbprod1',
    parent: ['Postcommit'],
    label: 'Smoke',
    shortLabel: 'Smoke',
    lane: 'Smoke',
    masterGroup: 'msp-master',
    masterName: 'master',
    versionRegex: /^ganges-(\d+(?:\.\d+)*)-stable$/,
    jobPrefix: 'ganges-',
    jobSuffix: '-stable',
  },
  {
    // Master LKG on SB Prod Controller-1 (Nupipe/LKG/master).
    id: 'lkg',
    controller: 'sbprod1',
    parent: ['Nupipe', 'LKG'],
    label: 'LKG',
    shortLabel: 'LKG',
    lane: 'LKG',
    masterGroup: 'lkg',
    masterName: 'master',
    // ganges-7.6-stable  (exclude the -pc and other trains like files-/ncc-)
    versionRegex: /^ganges-(\d+(?:\.\d+)*)-stable$/,
    jobPrefix: 'ganges-',
    jobSuffix: '-stable',
  },
  {
    // Current LKG home (7.6.x, 7.7, …). Versioned jobs only — master LKG is
    // the lkg rule above (sbprod1). Listed after `lkg` so overlapping versions
    // prefer this controller.
    id: 'lkg-c1',
    controller: 'sbprod1',
    parent: ['Nupipe', 'LKG'],
    label: 'LKG',
    shortLabel: 'LKG',
    lane: 'LKG',
    masterGroup: 'lkg',
    masterName: null,
    versionRegex: /^ganges-(\d+(?:\.\d+)*)-stable$/,
    jobPrefix: 'ganges-',
    jobSuffix: '-stable',
  },
];

const SLACK = {
  // Master switch for ALL Slack posts (10-fail alerts + master digest).
  // false = pause the channel; dashboard keeps polling. Tokens stay in place.
  enabled: (process.env.SLACK_ENABLED || 'true') !== 'false',
  channel: process.env.SLACK_CHANNEL || '#test-msp',
  mention: process.env.SLACK_MENTION || '@msp-help',
  // Prefer an incoming webhook; fall back to bot token chat.postMessage.
  webhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  // Bot token used with chat.postMessage. SLACK_BOT_TOKEN is the primary name;
  // SLACK_ALERT_BOT_TOKEN kept for backward-compat.
  botToken: process.env.SLACK_BOT_TOKEN || process.env.SLACK_ALERT_BOT_TOKEN || '',
  // App-level token (xapp-...). Only needed for Socket Mode / inbound events;
  // NOT used for posting. Recorded here so it can be wired later.
  appToken: process.env.SLACK_APP_TOKEN || '',
  // Re-alert suppression window (ms) so we don't spam on every poll.
  cooldownMs: Number(process.env.SLACK_COOLDOWN_MS || 6 * 60 * 60 * 1000),
};

/**
 * Scheduled "master pipeline health" digest.
 *
 * Rule: if any MASTER pipeline (the whole msp-master group — Precommit, Local
 * LCC, GLCC — plus standalone LKG) has >= `masterFailThreshold` consecutive
 * build failures, post the failing pipeline(s) to Slack.
 *
 * This is NOT a per-poll alert; it fires only at the configured local times
 * (default 09:00 in each listed timezone), so leadership gets a predictable
 * morning digest in both India and US-Pacific mornings.
 */
const TZ_ALIASES = {
  IST: 'Asia/Kolkata',
  PST: 'America/Los_Angeles',
  PT: 'America/Los_Angeles',
  PDT: 'America/Los_Angeles',
};

function resolveTZ(name) {
  const key = String(name || '').trim();
  return TZ_ALIASES[key.toUpperCase()] || key || 'UTC';
}

function parseHHMM(hm) {
  const [h, m] = String(hm || '09:00').split(':');
  const hour = Number(h);
  const minute = Number(m) || 0;
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** TIMES (24h HH:MM) × TZ (IST,PST or IANA). Legacy "HH:MM Zone,..." still works. */
function parseDigestSchedule() {
  const timesSpec = process.env.MASTER_DIGEST_TIMES || '09:00';
  const tzSpec = process.env.MASTER_DIGEST_TZ || 'IST,PST';
  const parts = String(timesSpec)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const legacy = !process.env.MASTER_DIGEST_TZ && parts.some((p) => p.split(/\s+/).length >= 2);
  if (legacy) {
    return parts.map((s) => {
      const [hm, tz] = s.split(/\s+/);
      const parsed = parseHHMM(hm) || { hour: 9, minute: 0 };
      return { ...parsed, tz: resolveTZ(tz || 'UTC') };
    });
  }
  const tzs = String(tzSpec)
    .split(',')
    .map((s) => resolveTZ(s.trim()))
    .filter(Boolean);
  const zones = tzs.length ? tzs : ['Asia/Kolkata', 'America/Los_Angeles'];
  const slots = [];
  for (const hm of parts) {
    const parsed = parseHHMM(hm);
    if (!parsed) continue;
    for (const tz of zones) slots.push({ ...parsed, tz });
  }
  return slots;
}

const MASTER_DIGEST = {
  enabled: (process.env.MASTER_DIGEST_ENABLED || 'true') !== 'false',
  // Consecutive-failure threshold that makes a master pipeline "report-worthy".
  failThreshold: Number(process.env.MASTER_FAIL_THRESHOLD || 5),
  // Channel for the digest (falls back to the general SLACK.channel).
  channel: process.env.MASTER_DIGEST_CHANNEL || process.env.SLACK_CHANNEL || '#test-msp',
  // Slots = MASTER_DIGEST_TIMES (HH:MM) × MASTER_DIGEST_TZ (IST/PST or IANA).
  times: parseDigestSchedule(),
};

// Optional green digest. Off unless SUCCESS_DIGEST_ENABLED=true.
const SUCCESS_DIGEST = {
  enabled: process.env.SUCCESS_DIGEST_ENABLED === 'true',
  threshold: Number(process.env.SUCCESS_THRESHOLD || 5),
}

const SETTINGS = {
  port: Number(process.env.PORT || 4317),
  // Bind to all interfaces by default so the dashboard is reachable from other
  // machines on the network. Override with HOST=127.0.0.1 to keep it local.
  host: process.env.HOST || '0.0.0.0',
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 3 * 60 * 1000),
  buildsToTrack: 10,
  // Patch-release (non-master version-block) lanes alert when consecutiveFailures >= this.
  patchFailThreshold: Number(process.env.PATCH_FAIL_THRESHOLD || 3),
  // Static Devtest lanes alert when consecutiveFailures >= this.
  devtestFailThreshold: Number(process.env.DEVTEST_FAIL_THRESHOLD || 3),
  httpTimeoutMs: Number(process.env.HTTP_TIMEOUT_MS || 20000),
  concurrency: Number(process.env.FETCH_CONCURRENCY || 8),
  dataDir: process.env.DATA_DIR || require('path').join(__dirname, '..', 'data'),
  // Explicit public URL for links in Slack messages (recommended behind a
  // proxy/DNS name). If unset, we derive it from the host's name/IP + PORT.
  dashboardUrl: process.env.DASHBOARD_URL || '',
};

/** First non-internal IPv4 address, or null. */
function firstLanIPv4() {
  const os = require('os');
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

/**
 * Best-effort public URL of this dashboard for use in Slack links.
 * Priority: DASHBOARD_URL env > hostname (FQDN if resolvable) > LAN IP > localhost.
 * When bound to a specific non-wildcard HOST, that value wins for the host part.
 */
function dashboardUrl() {
  if (SETTINGS.dashboardUrl) return SETTINGS.dashboardUrl.replace(/\/+$/, '');
  const os = require('os');
  let host;
  const boundHost = SETTINGS.host;
  if (boundHost && boundHost !== '0.0.0.0' && boundHost !== '::') {
    host = boundHost;
  } else {
    host = os.hostname() || firstLanIPv4() || 'localhost';
    // Bare, non-FQDN hostnames may not resolve off-box; prefer a routable IP.
    if (!host.includes('.') && host !== 'localhost') {
      host = firstLanIPv4() || host;
    }
  }
  const port = SETTINGS.port;
  const portPart = port === 80 ? '' : `:${port}`;
  return `http://${host}${portPart}`;
}

module.exports = {
  CONTROLLERS,
  STATIC_PIPELINES,
  DISCOVERY_RULES,
  SLACK,
  MASTER_DIGEST,
  SUCCESS_DIGEST,
  SETTINGS,
  dashboardUrl,
};
