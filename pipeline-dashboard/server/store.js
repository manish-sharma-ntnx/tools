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

  let consecutiveFailures = 0;
  for (const b of builds) {
    if (b.status === 'running') continue; // skip in-flight at head
    if (b.status === 'failed' || b.status === 'aborted' || b.status === 'unstable') {
      consecutiveFailures++;
    } else break;
  }

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
    allFailing:
      completed.length >= SETTINGS.buildsToTrack &&
      completed.slice(0, SETTINGS.buildsToTrack).every((b) => b.status !== 'success'),
  };
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

/** Assemble version blocks (clubbing master + patch releases per user's spec). */
function assembleVersionBlocks(discovery, cardByKey) {
  const blocks = [];

  // Master block clubs all lane masters together.
  const masterPipelines = discovery.masters
    .map((m) => cardByKey.get(m.key))
    .filter(Boolean);
  if (masterPipelines.length) {
    blocks.push({
      version: 'master',
      train: 'master',
      isMaster: true,
      label: 'Master',
      pipelines: masterPipelines,
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

  // Alerting: any pipeline whose last N completed builds all failed.
  const alerts = [];
  for (const card of allCards) {
    if (card.allFailing) {
      const entry = {
        key: card.key,
        title: card.title,
        lane: card.lane,
        version: card.version,
        url: card.url,
        window: SETTINGS.buildsToTrack,
        lastBuildNumber: card.lastBuildNumber,
        lastResult: card.builds[0] ? card.builds[0].result : 'FAILURE',
      };
      const outcome = await sendFailureAlert(entry);
      alerts.push({ ...entry, at: Date.now(), outcome });
    }
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

module.exports = { poll, getSnapshot, ensureDiscovery, normalizeStatus };
