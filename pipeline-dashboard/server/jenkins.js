'use strict';

const https = require('https');
const http = require('http');
const { CONTROLLERS, SETTINGS } = require('./config');

// Agents: one that tolerates internal self-signed certs, one strict.
const insecureAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const secureAgent = new https.Agent({ keepAlive: true });
const httpAgent = new http.Agent({ keepAlive: true });

/**
 * Low-level JSON GET against a Jenkins controller.
 * Returns { ok, status, data, error }.
 */
function getJson(controllerId, urlPath) {
  const controller = CONTROLLERS[controllerId];
  if (!controller) {
    return Promise.resolve({ ok: false, status: 0, error: `unknown controller ${controllerId}` });
  }
  const url = new URL(controller.baseUrl + urlPath);
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  const agent = isHttps ? (controller.insecure ? insecureAgent : secureAgent) : httpAgent;

  return new Promise((resolve) => {
    const req = lib.request(
      url,
      {
        method: 'GET',
        agent,
        headers: { Accept: 'application/json', 'User-Agent': 'msp-pipeline-dashboard/1.0' },
        timeout: SETTINGS.httpTimeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve({ ok: true, status: res.statusCode, data: JSON.parse(body) });
            } catch (e) {
              resolve({ ok: false, status: res.statusCode, error: 'invalid json' });
            }
          } else {
            resolve({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode}` });
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }));
    req.end();
  });
}

/** Build the Jenkins API path from folder segments + trailing api call. */
function jobApiPath(segments, apiSuffix) {
  const p = segments.map((s) => `/job/${encodeURIComponent(s)}`).join('');
  return `${p}/${apiSuffix}`;
}

/** Human-facing Jenkins job URL (for "open in Jenkins" links). */
function jobWebUrl(controllerId, segments) {
  const controller = CONTROLLERS[controllerId];
  const p = segments.map((s) => `/job/${encodeURIComponent(s)}`).join('');
  return `${controller.baseUrl}${p}/`;
}

/**
 * List child jobs of a folder (name + color only) for auto-discovery.
 */
async function listFolderJobs(controllerId, parentSegments) {
  const suffix = 'api/json?tree=jobs[name,color,_class]';
  const res = await getJson(controllerId, jobApiPath(parentSegments, suffix));
  if (!res.ok) return { ok: false, error: res.error, jobs: [] };
  return { ok: true, jobs: res.data.jobs || [] };
}

/**
 * Fetch a job's summary + last N builds.
 * `color` conveys building state (…_anime) and status; builds[] gives history.
 */
async function fetchJob(controllerId, segments, buildsToTrack) {
  const n = buildsToTrack || SETTINGS.buildsToTrack;
  const suffix =
    'api/json?tree=name,color,url,' +
    `builds[number,result,building,timestamp,duration,url]{0,${n}},` +
    'lastBuild[number,result,building,timestamp],' +
    'healthReport[score,description]';
  const res = await getJson(controllerId, jobApiPath(segments, suffix));
  return res;
}

/** Simple bounded-concurrency map. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

module.exports = {
  getJson,
  jobApiPath,
  jobWebUrl,
  listFolderJobs,
  fetchJob,
  mapLimit,
};
