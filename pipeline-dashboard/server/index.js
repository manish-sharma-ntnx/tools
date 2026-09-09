'use strict';

const http = require('http');
const path = require('path');
const { SETTINGS, MASTER_DIGEST, SUCCESS_DIGEST, SLACK } = require('./config');
const store = require('./store');
const { getAsset, isEmbedded } = require('./assets');
const { startMasterDigest, fireDigestTest } = require('./scheduler');
const { getAlertHistory } = require('./slack');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const data = getAsset(urlPath);
  if (data == null) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  const ext = path.extname(urlPath === '/' ? '/index.html' : urlPath);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, uptime: process.uptime() });
    }

    if (pathname === '/api/pipelines') {
      const snap = store.getSnapshot();
      // Cold start: trigger a poll if we have never generated a snapshot.
      if (!snap.generatedAt) {
        await store.poll();
      }
      return sendJson(res, 200, store.getSnapshot());
    }

    // "fetch latest releases" — force re-discovery of version-scoped jobs, then poll.
    if (pathname === '/api/refresh' && req.method === 'POST') {
      const force = url.searchParams.get('discovery') !== 'false';
      const snap = await store.poll({ forceDiscovery: force });
      return sendJson(res, 200, { ok: true, generatedAt: snap.generatedAt, blocks: snap.versionBlocks.length });
    }

    if (pathname === '/api/refresh' && req.method === 'GET') {
      const snap = await store.poll({ forceDiscovery: true });
      return sendJson(res, 200, { ok: true, generatedAt: snap.generatedAt });
    }

    // Per-pipeline alert history + computed frequency stats.
    if (pathname === '/api/alerts') {
      const hist = getAlertHistory();
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const round2 = (f) => Math.round(f * 100) / 100;
      let totalAlerts = 0;
      const pipelines = hist.map((h) => {
        totalAlerts += h.count;
        const ts = h.timestamps || [];
        const last7Days = ts.filter((t) => now - t <= 7 * dayMs).length;
        const last30Days = ts.filter((t) => now - t <= 30 * dayMs).length;
        const spanDays = Math.max(1, (now - h.firstAt) / dayMs);
        const perDay = round2(h.count / spanDays);
        const avgGapHours =
          h.count > 1 ? round2((h.lastAt - h.firstAt) / (h.count - 1) / (60 * 60 * 1000)) : 0;
        return {
          key: h.key,
          title: h.title,
          lane: h.lane,
          version: h.version,
          url: h.url,
          count: h.count,
          firstAt: h.firstAt,
          lastAt: h.lastAt,
          last7Days,
          last30Days,
          perDay,
          avgGapHours,
          timestamps: ts,
        };
      });
      return sendJson(res, 200, {
        generatedAt: now,
        pipelineCount: pipelines.length,
        totalAlerts,
        cooldownMs: SLACK.cooldownMs,
        failThreshold: MASTER_DIGEST.failThreshold,
        pipelines,
      });
    }

    // Preview which master pipelines currently meet the failure threshold.
    if (pathname === '/api/digest/preview') {
      const failing = store.getMasterFailures(MASTER_DIGEST.failThreshold);
      return sendJson(res, 200, {
        threshold: MASTER_DIGEST.failThreshold,
        channel: MASTER_DIGEST.channel,
        times: MASTER_DIGEST.times,
        count: failing.length,
        failing: failing.map((c) => ({
          title: c.title,
          lane: c.lane,
          consecutiveFailures: c.consecutiveFailures,
          lastBuildNumber: c.lastBuildNumber,
          url: c.url,
        })),
      });
    }

    // Manually fire the digest now (useful for testing the Slack post).
    if (pathname === '/api/digest/test' && req.method === 'POST') {
      await store.poll(); // ensure a fresh snapshot
      const failing = store.getMasterFailures(MASTER_DIGEST.failThreshold);
      const patchFailing = store.getPatchFailures();
      const outcome = await fireDigestTest();
      return sendJson(res, 200, {
        ok: true,
        posted: !!outcome.sent,
        count: failing.length,
        patchCount: patchFailing.length,
        patchThreshold: SETTINGS.patchFailThreshold,
        reason: outcome.reason || '',
        channel: MASTER_DIGEST.channel,
        slackEnabled: SLACK.enabled,
        hasBotToken: !!SLACK.botToken,
        successEnabled: SUCCESS_DIGEST.enabled,
        successThreshold: SUCCESS_DIGEST.threshold,
      });
    }

    return serveStatic(req, res);
  } catch (e) {
    console.error('[server] error:', e);
    return sendJson(res, 500, { ok: false, error: e.message });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[msp-dashboard] port ${SETTINGS.port} is already in use.\n` +
        `  Another instance is likely running. Options:\n` +
        `    - Use a different port:  PORT=4318 <run command>\n` +
        `    - Or stop the existing listener:  fuser -k ${SETTINGS.port}/tcp`
    );
  } else {
    console.error('[msp-dashboard] server error:', err.message);
  }
  process.exit(1);
});

server.listen(SETTINGS.port, SETTINGS.host, () => {
  const shownHost = SETTINGS.host === '0.0.0.0' ? '<this-host-ip>' : SETTINGS.host;
  console.log(`[msp-dashboard] listening on http://${shownHost}:${SETTINGS.port} (bound ${SETTINGS.host})`);
  console.log(`[msp-dashboard] assets: ${isEmbedded() ? 'embedded (portable build)' : 'disk (dev mode)'}`);
  console.log(`[msp-dashboard] poll interval: ${SETTINGS.pollIntervalMs / 1000}s, tracking last ${SETTINGS.buildsToTrack} builds`);
  store.poll().then((s) => {
    console.log(`[msp-dashboard] initial poll done: ${s.stats.total} pipelines, ${s.versionBlocks.length} blocks`);
    // Start the timezone-aware master-failure digest scheduler once we have data.
    startMasterDigest();
  }).catch((e) => console.error('[msp-dashboard] initial poll failed:', e.message));

  setInterval(() => {
    store.poll().catch((e) => console.error('[msp-dashboard] poll failed:', e.message));
  }, SETTINGS.pollIntervalMs);
});
