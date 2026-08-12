'use strict';

/**
 * Central configuration for the MSP Pipeline Dashboard.
 *
 * Jenkins controllers are read-only (anonymous). Each controller exposes the
 * standard Jenkins JSON API (`/api/json`) which is what we consume.
 *
 * Versioning discovered from the live controllers:
 *   - SB prod (LCC_NOS / LCC_Dial_Tests): jobs are named `msp-master` and
 *     `msp-ganges-<version>` (e.g. msp-ganges-7.6). The GLCC folder also has a
 *     `-pc` sibling for the PC pipeline.
 *   - Harbinger (LKG): jobs are named `master` and `ganges-<version>-stable`
 *     with an optional `-pc` sibling (e.g. ganges-7.6-stable, ganges-7.6-stable-pc).
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
    // msp-master  |  msp-ganges-7.6
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
    // Precommit per-version jobs on Harbinger-12. These feed the patch-release
    // comparison. They do NOT contribute a master card (that's precommit-master).
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
    id: 'lkg',
    controller: 'harbinger',
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
];

const SLACK = {
  channel: process.env.SLACK_CHANNEL || '#test-msp',
  mention: process.env.SLACK_MENTION || '@msp-help',
  // Prefer an incoming webhook; fall back to bot token chat.postMessage.
  webhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  botToken: process.env.SLACK_ALERT_BOT_TOKEN || '',
  // Re-alert suppression window (ms) so we don't spam on every poll.
  cooldownMs: Number(process.env.SLACK_COOLDOWN_MS || 6 * 60 * 60 * 1000),
};

const SETTINGS = {
  port: Number(process.env.PORT || 4317),
  // Bind to all interfaces by default so the dashboard is reachable from other
  // machines on the network. Override with HOST=127.0.0.1 to keep it local.
  host: process.env.HOST || '0.0.0.0',
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 3 * 60 * 1000),
  buildsToTrack: 10,
  httpTimeoutMs: Number(process.env.HTTP_TIMEOUT_MS || 20000),
  concurrency: Number(process.env.FETCH_CONCURRENCY || 8),
  dataDir: process.env.DATA_DIR || require('path').join(__dirname, '..', 'data'),
};

module.exports = {
  CONTROLLERS,
  STATIC_PIPELINES,
  DISCOVERY_RULES,
  SLACK,
  SETTINGS,
};
