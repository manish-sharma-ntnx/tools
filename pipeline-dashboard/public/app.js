'use strict';

const REFRESH_MS = 60000; // UI re-fetch of snapshot
let autoTimer = null;
let lastData = null;

const $ = (sel) => document.querySelector(sel);

const STATUS_LABEL = {
  success: 'Passing',
  failed: 'Failed',
  aborted: 'Aborted',
  running: 'Running',
  unstable: 'Unstable',
  unreachable: 'Unreachable',
  unknown: 'No data',
};

function timeAgo(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function fmtDuration(ms) {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function rateClass(rate) {
  if (rate === null) return '';
  if (rate >= 80) return 'good';
  if (rate >= 50) return 'mid';
  return 'bad';
}

async function fetchSnapshot() {
  const res = await fetch('/api/pipelines');
  return res.json();
}

async function triggerRefresh() {
  const btn = $('#btn-refresh');
  btn.classList.add('loading');
  btn.disabled = true;
  $('#refresh-label').textContent = 'Discovering…';
  try {
    await fetch('/api/refresh', { method: 'POST' });
    const data = await fetchSnapshot();
    render(data);
    flashLabel('Updated ✓');
  } catch (e) {
    flashLabel('Failed');
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

function flashLabel(msg) {
  const el = $('#refresh-label');
  el.textContent = msg;
  setTimeout(() => (el.textContent = 'Fetch latest releases'), 1800);
}

/* ---------- Renderers ---------- */

function renderSummary(data) {
  const s = data.stats;
  const overallHealth = s.total ? Math.round((s.success / (s.total - s.running || 1)) * 100) : 0;
  const kpis = [
    { cls: 'accent-total', label: 'Pipelines', value: s.total, foot: `${data.versionBlocks.length} version blocks` },
    { cls: 'accent-success', label: 'Passing', value: s.success, foot: `${overallHealth}% of completed` },
    { cls: 'accent-failed', label: 'Failing', value: s.failed + (s.unstable || 0), foot: s.unstable ? `${s.unstable} unstable` : 'incl. aborted' },
    { cls: 'accent-running', label: 'Running', value: s.running, foot: 'in progress now' },
    { cls: 'accent-health', label: 'Reachability', value: `${s.total - (s.unreachable || 0)}/${s.total}`, foot: (s.unreachable ? `${s.unreachable} unreachable` : 'all controllers up') },
  ];
  $('#summary').innerHTML = kpis
    .map(
      (k) => `<div class="kpi ${k.cls}">
        <div class="kpi-label">${k.label}</div>
        <div class="kpi-value">${k.value}</div>
        <div class="kpi-foot">${k.foot}</div>
      </div>`
    )
    .join('');
}

function renderAlerts(data) {
  const banner = $('#alert-banner');
  const failing = [];
  for (const b of data.versionBlocks) {
    for (const p of b.pipelines) {
      if (p.allFailing) failing.push(p);
    }
  }
  for (const p of data.static) if (p.allFailing) failing.push(p);

  if (!failing.length) {
    banner.hidden = true;
    return;
  }
  const names = failing.map((p) => `<b>${p.title}</b>`).join(', ');
  banner.hidden = false;
  banner.innerHTML = `<span class="alert-icon">🚨</span>
    <span>${failing.length} pipeline${failing.length > 1 ? 's have' : ' has'} failed the last 10 consecutive builds: ${names}.
    Slack alert sent to <b>#test-msp</b> (@msp-help).</span>`;
}

function statusPill(status) {
  const label = STATUS_LABEL[status] || status;
  return `<span class="status-pill st-${status}"><span class="sdot"></span>${label}</span>`;
}

function historyBars(builds) {
  const slots = [];
  for (let i = 0; i < 10; i++) {
    const b = builds[i];
    if (!b) {
      slots.push(`<div class="bar b-empty" data-empty="1"></div>`);
    } else {
      slots.push(
        `<div class="bar b-${b.status}" data-num="${b.number}" data-status="${b.status}" data-dur="${b.duration || 0}" data-ts="${b.timestamp || 0}"></div>`
      );
    }
  }
  // Oldest on left, newest on right: builds arrive newest-first, so reverse.
  return slots.reverse().join('');
}

function pipelineCard(p) {
  const rate = p.successRate;
  const rc = rateClass(rate);
  const laneTag = p.lane ? `<span class="lane-tag lane-${p.lane}">${p.lane}</span>` : '';
  const consec =
    p.consecutiveFailures >= 3
      ? `<span class="consec-warn">✕ ${p.consecutiveFailures} in a row</span>`
      : `<span>#${p.lastBuildNumber ?? '—'}</span>`;
  return `<div class="pcard" style="--stat: var(--${statVar(p.status)})">
    <div class="pcard-top">
      <div>
        <div class="pcard-title">${p.title}</div>
        <div class="pcard-sub">${p.subtitle}</div>
      </div>
      ${statusPill(p.status)}
    </div>
    <div class="history">
      <div class="bars">${historyBars(p.builds)}</div>
      <div class="history-meta">
        <div class="success-rate ${rc}">${rate === null ? '—' : rate + '%'}</div>
        <div class="rate-label">last ${p.completedCount || p.builds.length}</div>
      </div>
    </div>
    <div class="pcard-foot">
      <span>${laneTag} ${consec}</span>
      <span>${timeAgo(p.lastTimestamp)} · <a href="${p.url}" target="_blank" rel="noopener">Jenkins ↗</a></span>
    </div>
  </div>`;
}

function statVar(status) {
  return {
    success: 'green',
    failed: 'red',
    aborted: 'red',
    running: 'blue',
    unstable: 'amber',
    unreachable: 'gray',
    unknown: 'gray',
  }[status] || 'gray';
}

function blockSummaryDots(pipelines) {
  const counts = {};
  for (const p of pipelines) counts[p.status] = (counts[p.status] || 0) + 1;
  const order = ['failed', 'unstable', 'running', 'success', 'unreachable', 'unknown'];
  return order
    .filter((s) => counts[s])
    .map(
      (s) =>
        `<span class="mini-stat"><span class="mini-dot" style="background:var(--${statVar(s)})"></span>${counts[s]}</span>`
    )
    .join('');
}

// Order lanes consistently within the msp-master subgroup.
const LANE_ORDER = { Precommit: 0, LCC: 1, GLCC: 2, LKG: 3 };
function sortByLane(cards) {
  return [...cards].sort((a, b) => (LANE_ORDER[a.lane] ?? 9) - (LANE_ORDER[b.lane] ?? 9));
}

function renderBlocks(data) {
  const parts = [];

  // Devtest (static) section
  if (data.static && data.static.length) {
    parts.push(`<div class="section-title"><span>Devtest</span><span class="line"></span></div>`);
    parts.push(`<div class="block"><div class="block-body">${data.static.map(pipelineCard).join('')}</div></div>`);
  }

  const masterBlocks = data.versionBlocks.filter((b) => b.isMaster);
  const patchBlocks = data.versionBlocks.filter((b) => !b.isMaster);

  // ---- Master section: msp-master group (Precommit + Local LCC + GLCC) and standalone LKG ----
  if (masterBlocks.length) {
    const masterPipes = masterBlocks[0].pipelines;
    const mspMaster = sortByLane(masterPipes.filter((p) => p.masterGroup === 'msp-master'));
    const standalone = masterPipes.filter((p) => p.masterGroup !== 'msp-master');

    parts.push(`<div class="section-title"><span>Master Pipelines</span><span class="line"></span></div>`);
    parts.push(`<div class="blocks">`);

    if (mspMaster.length) {
      parts.push(`<div class="block is-master">
        <div class="block-head static">
          <span class="version-badge">msp-master</span>
          <span class="train-tag">Precommit · Local LCC · GLCC</span>
          <div class="block-summary">${blockSummaryDots(mspMaster)}</div>
        </div>
        <div class="block-body">${mspMaster.map(pipelineCard).join('')}</div>
      </div>`);
    }

    if (standalone.length) {
      parts.push(`<div class="block">
        <div class="block-head static">
          <span class="version-badge">LKG master</span>
          <span class="train-tag">standalone</span>
          <div class="block-summary">${blockSummaryDots(standalone)}</div>
        </div>
        <div class="block-body">${standalone.map(pipelineCard).join('')}</div>
      </div>`);
    }
    parts.push(`</div>`);
  }

  // ---- Patch Releases: side-by-side comparison of two selected versions ----
  if (patchBlocks.length) {
    parts.push(
      `<div class="section-title"><span>Patch Releases</span><span class="count">${patchBlocks.length} versions · compare two side by side</span><span class="line"></span></div>`
    );
    parts.push(renderCompare(patchBlocks));
  }

  $('#content').innerHTML = parts.join('');
  attachBlockToggles();
  attachBarTooltips();
  attachCompareControls(patchBlocks);
}

/* ---------- Patch-release side-by-side comparison ---------- */

// The three canonical lanes shown for every selected patch version, in order.
const COMPARE_LANES = ['Precommit', 'LCC', 'LKG'];
const LANE_LABELS = { Precommit: 'msp-precommit', LCC: 'Local LCC', GLCC: 'GLCC', LKG: 'LKG' };

// Persisted selection across re-renders.
let compareSel = { left: null, right: null };

// Placeholder card for a lane that has no Jenkins job at the selected version.
function missingLaneCard(lane, version) {
  return `<div class="pcard pcard-missing" style="--stat: var(--gray)">
    <div class="pcard-top">
      <div>
        <div class="pcard-title">${LANE_LABELS[lane] || lane}</div>
        <div class="pcard-sub">no pipeline for ${version}</div>
      </div>
      <span class="status-pill st-unknown"><span class="sdot"></span>N/A</span>
    </div>
    <div class="missing-note">
      <span class="lane-tag lane-${lane}">${lane}</span>
      <span>This lane has no build at <code>${version}</code></span>
    </div>
  </div>`;
}

// Vanguard/dev builds use a `.99` trailing segment (e.g. 7.5.99, 8.88). They are
// not real patch releases, so we skip them when picking sensible defaults (they
// remain selectable in the dropdown).
function isVanguard(version) {
  return /\.99($|\.)/.test(version) || /(^|\.)88($|\.)/.test(version);
}

// Default comparison = last two major trains: right = newest version of the
// latest train (N), left = newest real version of the previous train (N-1).
// e.g. left 7.5.2 (7.5 train), right 7.6.9.3 (7.6 train). patchBlocks is sorted
// newest-first, so the first block of each train is that train's newest version.
function defaultCompareVersions(patchBlocks) {
  if (!patchBlocks.length) return { left: null, right: null };
  const real = patchBlocks.filter((b) => !isVanguard(b.version));
  const pool = real.length ? real : patchBlocks;

  const latestTrain = pool[0].train;
  const right = pool[0].version; // newest real version of the latest train
  const prev = pool.find((b) => b.train !== latestTrain); // newest real of previous train
  const left = prev ? prev.version : (pool[1] ? pool[1].version : right);
  return { left, right };
}

function renderCompare(patchBlocks) {
  const versions = patchBlocks.map((b) => b.version);
  const def = defaultCompareVersions(patchBlocks);
  if (!compareSel.left || !versions.includes(compareSel.left)) compareSel.left = def.left;
  if (!compareSel.right || !versions.includes(compareSel.right)) compareSel.right = def.right;

  const options = (selected) =>
    versions
      .map((v) => {
        const b = patchBlocks.find((x) => x.version === v);
        const tag = b ? `${b.train} train` : '';
        return `<option value="${v}" ${v === selected ? 'selected' : ''}>${v}  ·  ${tag}</option>`;
      })
      .join('');

  const col = (side, selected) => {
    const block = patchBlocks.find((b) => b.version === selected);
    let body, summary;
    if (!block) {
      body = '<div class="empty-col">No version selected</div>';
      summary = '';
    } else {
      // Always show the three canonical lanes for this version, in fixed order.
      // Missing lanes (no Jenkins job for that version) render as placeholders.
      const cardsFor = COMPARE_LANES.map((lane) => {
        const p = block.pipelines.find((x) => x.lane === lane);
        return p ? pipelineCard(p) : missingLaneCard(lane, selected);
      });
      body = cardsFor.join('');
      // Summary counts only the present lanes.
      const present = COMPARE_LANES.map((l) => block.pipelines.find((x) => x.lane === l)).filter(Boolean);
      summary = blockSummaryDots(present);
    }
    return `<div class="compare-col">
      <div class="compare-head">
        <select class="version-select" data-side="${side}">${options(selected)}</select>
        <div class="compare-summary">${summary}</div>
      </div>
      <div class="compare-body">${body}</div>
    </div>`;
  };

  return `<div class="compare-grid">
    ${col('left', compareSel.left)}
    ${col('right', compareSel.right)}
  </div>`;
}

function attachCompareControls(patchBlocks) {
  document.querySelectorAll('.version-select').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      const side = e.target.dataset.side;
      compareSel[side] = e.target.value;
      // Re-render only the compare grid to preserve scroll where possible.
      const grid = document.querySelector('.compare-grid');
      if (grid) {
        grid.outerHTML = renderCompare(patchBlocks);
        attachCompareControls(patchBlocks);
        attachBarTooltips();
      }
    });
  });
}

function versionBlock(block, collapsed) {
  const cls = `block ${block.isMaster ? 'is-master' : ''} ${collapsed ? 'collapsed' : ''}`;
  const train = !block.isMaster ? `<span class="train-tag">${block.train} train</span>` : '';
  return `<div class="${cls}">
    <div class="block-head">
      <span class="version-badge">${block.isMaster ? '● master' : block.label}</span>
      ${train}
      <div class="block-summary">${blockSummaryDots(block.pipelines)}<span class="chevron">▾</span></div>
    </div>
    <div class="block-body">${block.pipelines.map(pipelineCard).join('')}</div>
  </div>`;
}

function attachBlockToggles() {
  document.querySelectorAll('.block-head:not(.static)').forEach((head) => {
    head.style.cursor = 'pointer';
    head.addEventListener('click', () => head.parentElement.classList.toggle('collapsed'));
  });
}

function attachBarTooltips() {
  const pop = $('#popover');
  document.querySelectorAll('.bar[data-num]').forEach((bar) => {
    bar.addEventListener('mouseenter', (e) => {
      const num = bar.dataset.num;
      const status = bar.dataset.status;
      const dur = fmtDuration(Number(bar.dataset.dur));
      const ts = timeAgo(Number(bar.dataset.ts));
      pop.innerHTML = `<div class="pop-title">Build #${num}</div>
        <div class="pop-row"><span class="pop-k">Result</span><span>${STATUS_LABEL[status] || status}</span></div>
        <div class="pop-row"><span class="pop-k">Duration</span><span>${dur}</span></div>
        <div class="pop-row"><span class="pop-k">When</span><span>${ts}</span></div>`;
      pop.hidden = false;
      const r = bar.getBoundingClientRect();
      pop.style.left = Math.min(r.left, window.innerWidth - 280) + 'px';
      pop.style.top = r.top - pop.offsetHeight - 10 + 'px';
    });
    bar.addEventListener('mouseleave', () => (pop.hidden = true));
  });
}

function renderMeta(data) {
  $('#updated').textContent = 'Updated ' + timeAgo(data.generatedAt);
  const stale = Date.now() - data.generatedAt > 5 * 60 * 1000;
  const li = $('#live-indicator');
  li.classList.toggle('stale', stale);
  $('#live-text').textContent = stale ? 'Stale' : 'Live';

  // controller chips
  const controllers = new Set();
  const down = new Set();
  const all = [...(data.static || []), ...data.versionBlocks.flatMap((b) => b.pipelines)];
  for (const p of all) {
    controllers.add(p.controller);
    if (p.status === 'unreachable') down.add(p.controller);
  }
  const labels = { devtest: 'Devtest', sbprod: 'SB Prod', harbinger: 'Harbinger-14', harbinger12: 'Harbinger-12' };
  $('#foot-controllers').innerHTML = [...controllers]
    .map((c) => `<span class="ctrl-chip ${down.has(c) ? 'down' : ''}"><span class="cdot"></span>${labels[c] || c}</span>`)
    .join('');
}

function render(data) {
  lastData = data;
  renderSummary(data);
  renderAlerts(data);
  renderBlocks(data);
  renderMeta(data);
}

async function tick() {
  try {
    const data = await fetchSnapshot();
    render(data);
  } catch (e) {
    console.error('fetch failed', e);
  }
}

function init() {
  $('#btn-refresh').addEventListener('click', triggerRefresh);
  tick();
  autoTimer = setInterval(tick, REFRESH_MS);
}

document.addEventListener('DOMContentLoaded', init);
