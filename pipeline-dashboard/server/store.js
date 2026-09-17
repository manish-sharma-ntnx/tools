'use strict';

const { SETTINGS, STATIC_PIPELINES } = require('./config');
const { fetchJob, jobWebUrl, mapLimit } = require('./jenkins');
const { discoverPipelines, sortedVersions, trainOf } = require('./discovery');
const { sendFailureAlert } = require('./slack');

/**
 * In-memory snapshot of the whole dashboard. Rebuilt every poll.
 */
let SNAPSHOT = {
  generatedAt: 0,
  polling: false,
  controllers: {},
  static: [],
  masters: [],
  versionBlocks: [], // [{ version, train, isMaster, pipelines: [...] }]
  discoveryErrors: [],
  stats: { total: 0, success: 0, failed: 0, running: 0, unstable: 0, unknown: 0 },
  alerts: [],
};

let DISCOVERY = null; // cached discovery result
let lastDiscoveryAt = 0;

/** Normalize a Jenkins build result + building flag into our status vocabulary. */
function normalizeStatus(build) {
  if (!build) return 'unknown';
  if (build.building) return 'running';
  switch (build.result) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
      return 'failed';
    case 'UNSTABLE':
      return 'unstable';
    case 'ABORTED':
      return 'aborted';
    case null:
    case undefined:
      return 'running';
    default:
      return String(build.result).toLowerCase();
  }
}

/** Turn a raw Jenkins job response into a normalized pipeline card. */
function toPipelineCard(meta, res) {
  const base = {
    key: meta.key,
    title: meta.title,
    subtitle: meta.subtitle,
    lane: meta.lane || null,
    version: meta.version || null,
    controller: meta.controller,
    masterGroup: meta.masterGroup || null,
    synthesizedFrom: meta.synthesizedFrom || null,
    url: jobWebUrl(meta.controller, meta.path),
    category: meta.category || 'pipeline',
  };

  if (!res || !res.ok || !res.data) {
    return {
      ...base,
      status: 'unreachable',
      reachable: false,
      error: (res && res.error) || 'no data',
      builds: [],
      lastBuildNumber: null,
      health: null,
      successRate: null,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
    };
  }

  const data = res.data;
  const builds = (data.builds || []).map((b) => ({
    number: b.number,
    status: normalizeStatus(b),
    result: b.result,
    building: !!b.building,
    timestamp: b.timestamp,
    duration: b.duration,
    url: b.url,
  }));

  const last = builds[0] || null;
  const status = last ? last.status : 'unknown';

  // Completed builds only for success-rate + consecutive failure math.
  const completed = builds.filter((b) => b.status !== 'running');
  const successCount = completed.filter((b) => b.status === 'success').length;
  const successRate = completed.length ? Math.round((successCount / completed.length) * 100) : null;

  const { consecutiveFailures, consecutiveSuccesses, allFailing } = computeStreaks(
    completed,
    SETTINGS.buildsToTrack
  );

  const health = (data.healthReport && data.healthReport[0]) || null;

  return {
    ...base,
    status,
    reachable: true,
    builds,
    lastBuildNumber: last ? last.number : null,
    lastTimestamp: last ? last.timestamp : null,
    health: health ? { score: health.score, description: health.description } : null,
    successRate,
    completedCount: completed.length,
    consecutiveFailures,
    consecutiveSuccesses,
    allFailing,
  };
}

/** Latest completed (non-running) build, or null. */
function latestCompleted(builds) {
  return (builds || []).find((b) => b.status !== 'running') || null;
}

/**
 * Authentic FAILURE streaks from newest completed build backwards.
 * aborted/unstable do not count as failures and break the streak.
 * allFailing requires the last `track` completed builds to all be FAILURE;
 * in-flight builds must not inflate the window.
 */
function computeStreaks(completed, track) {
  let consecutiveFailures = 0;
  for (const b of completed) {
    if (b.status === 'failed') consecutiveFailures++;
    else break;
  }
  let consecutiveSuccesses = 0;
  for (const b of completed) {
    if (b.status === 'success') consecutiveSuccesses++;
    else break;
  }
  const allFailing =
    track > 0 &&
    completed.length >= track &&
    completed.slice(0, track).every((b) => b.status === 'failed');
  return { consecutiveFailures, consecutiveSuccesses, allFailing };
}

function failLaneOf(key, masterKeys, devtestKeys) {
  if (masterKeys.has(key)) return 'master';
  if (devtestKeys.has(key)) return 'devtest';
  return 'patch';
}

function thresholdFor(lane) {
  if (lane === 'devtest') return SETTINGS.devtestFailThreshold;
  if (lane === 'patch') return SETTINGS.patchFailThreshold;
  return null;
}

/**
 * Slack gate: 10-in-a-row (allFailing) for any reachable pipeline,
 * DEVTEST_FAIL_THRESHOLD for static Devtest, or PATCH_FAIL_THRESHOLD for
 * version-block (patch-release) lanes. Master stays on the scheduled digest.
 */
function shouldFireFailureAlert(card, lane) {
  if (!card || !card.reachable) return false;
  if (card.allFailing) return true;
  const t = thresholdFor(lane);
  return t != null && card.consecutiveFailures >= t;
}

/** Refresh discovery (folder listing) if stale or forced. */
async function ensureDiscovery(force) {
  const stale = Date.now() - lastDiscoveryAt > 30 * 60 * 1000; // 30 min
  if (force || !DISCOVERY || stale) {
    DISCOVERY = await discoverPipelines();
    lastDiscoveryAt = Date.now();
  }
  return DISCOVERY;
}

/** Build the full list of pipeline metas to fetch (static + discovered). */
function buildFetchList(discovery) {
  const list = [];
  for (const s of STATIC_PIPELINES) list.push(s);
  for (const m of discovery.masters) list.push(m);
  for (const version of Object.keys(discovery.versions)) {
    for (const p of discovery.versions[version]) list.push(p);
  }
  return list;
}

const MASTER_BLOCK_ORDER = ['msp-master', 'master'];

function masterGroupOf(meta) {
  const g = meta && meta.masterGroup;
  if (!g || g === 'lkg' || g === 'other') return 'master';
  return g;
}

/** Assemble version blocks. msp-master and product master stay separate. */
function assembleVersionBlocks(discovery, cardByKey) {
  const blocks = [];

  const grouped = new Map();
  for (const m of discovery.masters || []) {
    const card = cardByKey.get(m.key);
    if (!card) continue;
    const g = masterGroupOf(m);
    if (!grouped.has(g)) grouped.set(g, []);
    grouped.get(g).push(card);
  }
  for (const g of MASTER_BLOCK_ORDER) {
    const pipelines = grouped.get(g);
    if (!pipelines || !pipelines.length) continue;
    blocks.push({
      version: g,
      train: g,
      isMaster: true,
      label: g,
      pipelines,
    });
    grouped.delete(g);
  }
  for (const [g, pipelines] of grouped) {
    if (!pipelines.length) continue;
    blocks.push({
      version: g,
      train: g,
      isMaster: true,
      label: g,
      pipelines,
    });
  }

  // Patch-release blocks, newest version first.
  for (const version of sortedVersions(discovery.versions)) {
    const pipelines = discovery.versions[version]
      .map((p) => cardByKey.get(p.key))
      .filter(Boolean);
    blocks.push({
      version,
      train: trainOf(version),
      isMaster: false,
      label: version,
      pipelines,
    });
  }
  return blocks;
}

function computeStats(cards) {
  const stats = { total: 0, success: 0, failed: 0, running: 0, unstable: 0, unknown: 0, unreachable: 0 };
  for (const c of cards) {
    stats.total++;
    if (c.status === 'success') stats.success++;
    else if (c.status === 'failed' || c.status === 'aborted') stats.failed++;
    else if (c.status === 'running') stats.running++;
    else if (c.status === 'unstable') stats.unstable++;
    else if (c.status === 'unreachable') stats.unreachable++;
    else stats.unknown++;
  }
  return stats;
}

/** Full poll: discover (if needed), fetch all jobs, assemble snapshot, alert. */
async function poll({ forceDiscovery = false } = {}) {
  SNAPSHOT.polling = true;
  const discovery = await ensureDiscovery(forceDiscovery);
  const metas = buildFetchList(discovery);

  const results = await mapLimit(metas, SETTINGS.concurrency, async (meta) => {
    const res = await fetchJob(meta.controller, meta.path, SETTINGS.buildsToTrack);
    return { meta, card: toPipelineCard(meta, res) };
  });

  const cardByKey = new Map();
  for (const r of results) cardByKey.set(r.meta.key, r.card);

  const staticCards = STATIC_PIPELINES.map((s) => cardByKey.get(s.key)).filter(Boolean);
  const versionBlocks = assembleVersionBlocks(discovery, cardByKey);
  const allCards = results.map((r) => r.card);

  const masterKeys = new Set();
  for (const block of versionBlocks) {
    if (!block.isMaster) continue;
    for (const c of block.pipelines || []) masterKeys.add(c.key);
  }
  const devtestKeys = new Set(STATIC_PIPELINES.map((s) => s.key));

  // Alerting:
  //  1) per-pipeline 10-in-a-row (card.allFailing) → Slack for any pipeline.
  //  2) DEVTEST_FAIL_THRESHOLD / PATCH_FAIL_THRESHOLD for those lanes.
  //     Slack text uses the observed streak (not buildsToTrack).
  const alerts = [];
  for (const card of allCards) {
    if (!shouldFireFailureAlert(card, failLaneOf(card.key, masterKeys, devtestKeys))) continue;
    const latest = latestCompleted(card.builds);
    const entry = {
      key: card.key,
      title: card.title,
      lane: card.lane,
      version: card.version,
      url: card.url,
      window: card.consecutiveFailures,
      lastBuildNumber: latest ? latest.number : card.lastBuildNumber,
      lastResult: latest ? (latest.result || String(latest.status).toUpperCase()) : '',
    };
    const outcome = await sendFailureAlert(entry);
    alerts.push({ ...entry, at: Date.now(), outcome });
  }

  SNAPSHOT = {
    generatedAt: Date.now(),
    polling: false,
    static: staticCards,
    masters: versionBlocks.filter((b) => b.isMaster),
    versionBlocks,
    discoveryErrors: discovery.errors,
    discoveredAt: discovery.discoveredAt,
    stats: computeStats(allCards),
    alerts,
  };
  return SNAPSHOT;
}

function getSnapshot() {
  return SNAPSHOT;
}

/**
 * Return the master-block pipelines whose consecutiveFailures >= threshold.
 * "Master" = every pipeline in blocks flagged isMaster (msp-master + master).
 * Sorted worst-first (most consecutive failures at the top).
 */
function getMasterFailures(threshold) {
  const t = Number(threshold) || 1;
  const masterBlocks = (SNAPSHOT.versionBlocks || []).filter((b) => b.isMaster);
  const failing = [];
  for (const block of masterBlocks) {
    for (const card of block.pipelines || []) {
      if ((card.consecutiveFailures || 0) >= t) failing.push(card);
    }
  }
  failing.sort((a, b) => (b.consecutiveFailures || 0) - (a.consecutiveFailures || 0));
  return failing;
}

/**
 * Return version-block (non-master) pipelines whose consecutiveFailures >=
 * PATCH_FAIL_THRESHOLD. Sorted worst-first.
 */
function getPatchFailures() {
  const t = Number(SETTINGS.patchFailThreshold) || 3;
  const failing = [];
  for (const block of SNAPSHOT.versionBlocks || []) {
    if (block.isMaster) continue;
    for (const card of block.pipelines || []) {
      if ((card.consecutiveFailures || 0) >= t) failing.push(card);
    }
  }
  failing.sort((a, b) => (b.consecutiveFailures || 0) - (a.consecutiveFailures || 0));
  return failing;
}

/**
 * Return static Devtest pipelines whose consecutiveFailures >=
 * DEVTEST_FAIL_THRESHOLD. Sorted worst-first.
 */
function getDevtestFailures() {
  const t = Number(SETTINGS.devtestFailThreshold) || 3;
  const failing = [];
  for (const card of SNAPSHOT.static || []) {
    if ((card.consecutiveFailures || 0) >= t) failing.push(card);
  }
  failing.sort((a, b) => (b.consecutiveFailures || 0) - (a.consecutiveFailures || 0));
  return failing;
}

/**
 * Return master-block pipelines whose consecutiveSuccesses >= threshold,
 * best-first. Used by the optional success digest.
 */
function getMasterSuccesses(threshold) {
  const t = Number(threshold) || 1;
  const masterBlocks = (SNAPSHOT.versionBlocks || []).filter((b) => b.isMaster);
  const ok = [];
  for (const block of masterBlocks) {
    for (const card of block.pipelines || []) {
      if ((card.consecutiveSuccesses || 0) >= t) ok.push(card);
    }
  }
  ok.sort((a, b) => (b.consecutiveSuccesses || 0) - (a.consecutiveSuccesses || 0));
  return ok;
}

module.exports = {
  poll,
  getSnapshot,
  getMasterFailures,
  getPatchFailures,
  getDevtestFailures,
  getMasterSuccesses,
  ensureDiscovery,
  normalizeStatus,
  computeStreaks,
  shouldFireFailureAlert,
};
