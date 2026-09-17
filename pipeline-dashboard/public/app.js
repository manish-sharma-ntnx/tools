'use strict';

/* ============================================================
   Code Tracker UI — maps the existing /api/pipelines snapshot
   onto the code-tracker layout (KPI strip + component timeline).

   Top-level tabs: Branches (live Jenkins) plus empty CFDs /
   Analytics / Cherry-Picks placeholders.
   ============================================================ */

const REFRESH_MS = 60000;
let lastData = null;
let activeTab = 'branches';
let searchTerm = '';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const STATUS_LABEL = {
  success: 'Passing',
  failed: 'Failed',
  aborted: 'Aborted',
  running: 'Running',
  unstable: 'Unstable',
  unreachable: 'Unreachable',
  unknown: 'No data',
};

const VIEW_TITLE = {
  branches: 'master',
  cfds: 'CFDs',
  analytics: 'Analytics',
  cherry: 'Cherry-Picks',
};

// Stage columns map to Jenkins lanes we actually track.
const STAGES = [
  { id: 'precommit', label: 'PRECOMMIT PIPELINE', lane: 'Precommit', kind: 'lane' },
  { id: 'local-lcc', label: 'LOCAL LCC', lane: 'LCC', kind: 'lane' },
  { id: 'global-lcc', label: 'GLOBAL LCC', lane: 'GLCC', kind: 'lane' },
  { id: 'smoke', label: 'SMOKE', lane: 'Smoke', kind: 'lane' },
  { id: 'lkg', label: 'LKG', lane: 'LKG', kind: 'lane' },
];

/* ---------- helpers ---------- */

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
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtClock(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  return `${date}, ${time}`;
}

function rateClass(rate) {
  if (rate === null || rate === undefined) return '';
  if (rate >= 80) return 'good';
  if (rate >= 50) return 'mid';
  return 'bad';
}

async function fetchSnapshot() {
  const res = await fetch('/api/pipelines', { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' from /api/pipelines');
  const data = await res.json();
  if (!data || typeof data !== 'object') throw new Error('invalid snapshot JSON');
  return data;
}

async function triggerRefresh() {
  const btn = $('#btn-refresh');
  const spin = $('#refresh-spinner');
  btn.disabled = true;
  spin.hidden = false;
  $('#refresh-label').textContent = 'Fetching…';
  try {
    await fetch('/api/refresh', { method: 'POST' });
    const data = await fetchSnapshot();
    render(data);
    $('#refresh-label').textContent = 'Updated ✓';
  } catch (e) {
    $('#refresh-label').textContent = 'Failed';
  } finally {
    setTimeout(() => ($('#refresh-label').textContent = 'Fetch latest'), 1600);
    btn.disabled = false;
    spin.hidden = true;
  }
}

/* ---------- data shaping ---------- */

function allCards(data) {
  const out = [...(data.static || [])];
  for (const b of data.versionBlocks || []) out.push(...(b.pipelines || []));
  return out;
}

function buildComponents(data) {
  const rows = [];
  const blocks = data.versionBlocks || [];

  // Static pipelines (Devtest) are not version-scoped, so they never appear
  // in versionBlocks. Surface them as the first timeline row or they are
  // invisible on the board while still able to Slack-alert.
  const staticCards = (data.static || []).filter(Boolean);
  if (staticCards.length) {
    rows.push({
      name: 'devtest',
      tag: 'DEVTEST',
      lanes: staticCards.map((c) => ({ ...c, lane: c.lane || 'Precommit' })),
      isMaster: false,
      isStatic: true,
    });
  }

  for (const b of blocks.filter((x) => x.isMaster)) {
    const name = b.version || b.label || 'master';
    rows.push({
      name,
      tag: name === 'msp-master' ? 'MSP' : 'MAIN',
      lanes: b.pipelines,
      isMaster: true,
    });
  }

  for (const b of blocks.filter((x) => !x.isMaster)) {
    rows.push({
      name: `ganges-${b.version}`,
      tag: b.train ? `${b.train}` : 'COMP',
      lanes: b.pipelines,
      isMaster: false,
      version: b.version,
    });
  }

  return rows;
}

function cardForLane(row, lane) {
  const lanes = row && Array.isArray(row.lanes) ? row.lanes : [];
  return lanes.find((p) => p && p.lane === lane) || null;
}

/* ---------- KPI strip ---------- */

function renderKpis(data) {
  const cards = allCards(data);
  const s = data.stats || {};

  const masterBlocks = (data.versionBlocks || []).filter((b) => b.isMaster);
  const blockNamed = (name) => masterBlocks.find((b) => b.version === name);
  const productLanes = (blockNamed('master') && blockNamed('master').pipelines) || [];
  const mspLanes = (blockNamed('msp-master') && blockNamed('msp-master').pipelines) || [];
  // Hero KPI is product master LKG (Nupipe/LKG/master), not ValPromote.
  const masterLkg = productLanes.find((p) => p.lane === 'LKG') || null;
  const smokeRows = [
    ...['Precommit', 'LCC', 'GLCC'].map((lane) => mspLanes.find((p) => p.lane === lane)),
    productLanes.find((p) => p.lane === 'Smoke'),
    mspLanes.find((p) => p.lane === 'LKG'),
  ].filter(Boolean);

  const failing = cards.filter((c) => c.allFailing);
  const failNames = [...new Set(failing.map((c) => c.title))];

  const kpi1 = `
    <div class="kpi-card">
      <div class="kpi-eyebrow">Last Successful LKG</div>
      ${
        masterLkg
          ? `<div class="kpi-big">${timeAgo(masterLkg.lastTimestamp)}</div>
             <div class="kpi-sub">${fmtClock(masterLkg.lastTimestamp)} · ${masterLkg.subtitle || 'master'}</div>
             <a class="kpi-link" href="${masterLkg.url}" target="_blank" rel="noopener">View Build →</a>`
          : `<div class="kpi-big red">none</div>
             <div class="kpi-sub">master LKG not discovered</div>`
      }
      <div class="kpi-rows">
        <div class="kpi-rowsub" style="font-weight:700;letter-spacing:.5px;">SMOKE / DIAL</div>
        ${smokeRows
          .map((p) => {
            const ok = p.status === 'success';
            const cls = ok ? 'pass' : p.status === 'unreachable' || p.status === 'unknown' ? 'na' : 'fail';
            const word = ok ? 'Pass' : p.status === 'unreachable' ? 'N/A' : 'Fail';
            return `<div class="kpi-row"><span class="k">${p.title}</span><span class="v ${cls}">${word} · ${timeAgo(p.lastTimestamp)}</span></div>`;
          })
          .join('') || '<div class="ticket-placeholder">no master lanes discovered</div>'}
      </div>
    </div>`;

  const kpi2 = `
    <div class="kpi-card">
      <div class="kpi-eyebrow">Pipeline ETA</div>
      <div class="kpi-big blue">~ —</div>
      <div class="kpi-sub">avg merge-to-LKG</div>
      <div class="kpi-rows">
        <a class="kpi-link">View Trends →</a>
        <div class="todo-hint">TODO: ETA needs commit-flow source (Gerrit/git)</div>
      </div>
    </div>`;

  const running = s.running || 0;
  const total = s.total || 0;
  const kpi3 = `
    <div class="kpi-card">
      <div class="kpi-eyebrow">Pipeline Volume</div>
      <div class="kpi-count">
        <div class="kpi-count-item"><span class="kpi-count-num">${total}</span><span class="kpi-count-txt">pipelines tracked<br/>across ${(data.versionBlocks || []).length} blocks</span></div>
        <div class="kpi-count-item"><span class="kpi-count-num blue">${running}</span><span class="kpi-count-txt">currently running</span></div>
      </div>
      <div class="todo-hint">TODO: commit counts per component</div>
    </div>`;

  const passing = s.success || 0;
  const kpi4 = `
    <div class="kpi-card">
      <div class="kpi-eyebrow">Health</div>
      <div class="kpi-count">
        <div class="kpi-count-item"><span class="kpi-count-num" style="color:var(--green)">${passing}</span><span class="kpi-count-txt">passing</span></div>
        <div class="kpi-count-item"><span class="kpi-count-num">${(s.failed || 0) + (s.unstable || 0)}</span><span class="kpi-count-txt">failing / unstable</span></div>
      </div>
      <div class="kpi-sub">${s.unreachable ? s.unreachable + ' unreachable' : 'all controllers up'}</div>
    </div>`;

  const kpiFail = `
    <div class="kpi-card kpi-fail">
      <div class="kpi-eyebrow-row">
        <div class="kpi-fail-title">⚠ ${failNames.length} ${failNames.length === 1 ? 'PIPELINE' : 'PIPELINES'} FAILING</div>
        ${failNames.length ? '<span class="click-filter">Click to filter</span>' : ''}
      </div>
      ${
        failNames.length
          ? `<div class="kpi-fail-branches">${failNames.slice(0, 6).join(', ')}${failNames.length > 6 ? ` +${failNames.length - 6} more` : ''}</div>
             <div class="tickets-label">Tracking Tickets</div>
             <div class="ticket-placeholder">TODO: DIAL/CR ticket mapping (needs JIRA/Gerrit source)</div>`
          : `<div class="kpi-fail-clear">✓ No pipelines failing all last 10 builds</div>`
      }
    </div>`;

  $('#kpi-strip').innerHTML = kpi1 + kpi2 + kpi3 + kpi4 + kpiFail;
}

/* ---------- Component timeline ---------- */

function sparkbars(builds) {
  const slots = [];
  for (let i = 0; i < 10; i++) {
    const b = builds[i];
    if (!b) slots.push('<div class="bar b-empty"></div>');
    else
      slots.push(
        `<div class="bar b-${b.status}" data-num="${b.number}" data-status="${b.status}" data-dur="${b.duration || 0}" data-ts="${b.timestamp || 0}"></div>`
      );
  }
  return `<div class="sparkbars">${slots.reverse().join('')}</div>`;
}

function laneCell(card) {
  if (!card) {
    return `<div class="stage-cell empty">—</div>`;
  }
  if (!card.reachable && card.status === 'unreachable') {
    return `<div class="stage-cell"><span class="chip fail">unreachable</span><div class="stage-sub">${card.subtitle || ''}</div></div>`;
  }
  const rate = card.successRate;
  const consec = card.consecutiveFailures || 0;
  const statusChip =
    card.status === 'running'
      ? `<span class="chip test">Running</span>`
      : consec >= 1 && card.status !== 'success'
      ? `<span class="chip fail">Failed${consec > 1 ? ` ×${consec}` : ''}</span>`
      : `<span class="chip pass">Passing</span>`;
  const build = card.lastBuildNumber != null
    ? `<a class="stage-build" href="${card.url}" target="_blank" rel="noopener">Build #${card.lastBuildNumber} ↗</a>`
    : '';
  return `<div class="stage-cell">
    <div><span class="stage-count">${rate === null || rate === undefined ? '—' : rate + '%'}</span> <span class="stage-oldest">${timeAgo(card.lastTimestamp)}</span></div>
    <div class="stage-line">${statusChip}</div>
    <div>${sparkbars(card.builds || [])}</div>
    <div>${build}</div>
  </div>`;
}

function componentRow(row, idx) {
  const crMeta = row.isMaster
    ? `<span class="cr">${row.name}</span>`
    : row.isStatic
    ? `<span class="cr">devtest</span>`
    : `<span class="cr">${row.version || ''}</span>`;
  const tagClass = row.isMaster ? 'main' : row.isStatic ? 'devtest' : 'comp';
  const laneCards = Array.isArray(row.lanes) ? row.lanes : [];
  const anyFail = laneCards.some((p) => p && p.allFailing);

  const stageCells = STAGES.map((stage) => laneCell(cardForLane(row, stage.lane))).join('');
  const detail = laneCards
    .map((c) => {
      const rc = rateClass(c.successRate);
      return `<div class="detail-lane">
        <div class="detail-lane-head">
          <span class="detail-lane-name">${c.title}</span>
          <span class="status-pill st-${c.status}"><span class="sdot"></span>${STATUS_LABEL[c.status] || c.status}</span>
        </div>
        <div>${sparkbars(c.builds || [])}</div>
        <div class="detail-lane-meta">
          <span>#${c.lastBuildNumber ?? '—'} · ${timeAgo(c.lastTimestamp)}</span>
          <span class="detail-rate ${rc}">${c.successRate === null || c.successRate === undefined ? '—' : c.successRate + '%'}</span>
        </div>
        <div class="detail-lane-meta"><a href="${c.url}" target="_blank" rel="noopener">Open in Jenkins ↗</a>${c.lane ? `<span>${c.lane}</span>` : ''}</div>
      </div>`;
    })
    .join('');

  return `<div class="tl-row" data-name="${row.name.toLowerCase()}">
    <div class="tl-row-stages">
      <div class="tl-comp">
        <span class="tl-comp-caret" data-toggle="${idx}">▸</span>
        <div class="tl-comp-body">
          <div class="tl-comp-name">${row.name} ${anyFail ? '<span class="warn">●</span>' : ''} <span class="tl-tag ${tagClass}">${row.tag}</span></div>
          <div class="tl-comp-meta">${crMeta} <span class="todo-hint">· commits TODO</span></div>
        </div>
      </div>
      ${stageCells}
    </div>
    <div class="tl-detail">
      <div class="tl-detail-grid">${detail || '<div class="tab-empty">No lane data.</div>'}</div>
    </div>
  </div>`;
}

function renderTimeline(data) {
  const rows = buildComponents(data);

  const cards = allCards(data);
  const runningCard = cards.find((c) => c.status === 'running');
  const jp = $('#job-progress');
  if (runningCard) {
    jp.hidden = false;
    $('#job-label').textContent = `${runningCard.title} #${runningCard.lastBuildNumber ?? ''}`;
    $('#job-bar-fill').style.width = '55%';
    $('#job-pct').textContent = 'running · ETA TODO';
    $('#job-jenkins').href = runningCard.url;
  } else {
    jp.hidden = true;
  }

  const filtered = searchTerm
    ? rows.filter((r) => r.name.toLowerCase().includes(searchTerm))
    : rows;

  const html = filtered.map((r, i) => componentRow(r, i)).join('');
  $('#rows').innerHTML = html || '<div class="tab-empty">No components match.</div>';

  attachRowToggles();
  attachBarTooltips();
}

function attachRowToggles() {
  $$('.tl-comp-caret').forEach((c) => {
    c.addEventListener('click', () => {
      const rowEl = c.closest('.tl-row');
      rowEl.classList.toggle('expanded');
    });
  });
}

let allExpanded = false;
function toggleExpandAll() {
  allExpanded = !allExpanded;
  $$('.tl-row').forEach((r) => r.classList.toggle('expanded', allExpanded));
  $('#expand-all').textContent = allExpanded ? 'Collapse All' : 'Expand All';
}

function attachBarTooltips() {
  const pop = $('#popover');
  $$('.bar[data-num]').forEach((bar) => {
    bar.addEventListener('mouseenter', () => {
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
      pop.style.left = Math.min(r.left, window.innerWidth - 200) + 'px';
      pop.style.top = Math.max(8, r.top - pop.offsetHeight - 8) + 'px';
    });
    bar.addEventListener('mouseleave', () => (pop.hidden = true));
  });
}

/* ---------- meta / footer ---------- */

function renderMeta(data) {
  const stale = Date.now() - data.generatedAt > 5 * 60 * 1000;
  const dot = $('#live-dot');
  dot.title = stale ? 'Stale snapshot' : 'Live · updated ' + timeAgo(data.generatedAt);
  dot.style.borderColor = stale ? 'var(--amber)' : '';

  const badge = $('#active-badge');
  badge.innerHTML = stale
    ? '<span class="active-dot" style="background:var(--amber)"></span>Stale'
    : '<span class="active-dot"></span>Active';

  const controllers = new Set();
  const down = new Set();
  for (const p of allCards(data)) {
    controllers.add(p.controller);
    if (p.status === 'unreachable') down.add(p.controller);
  }
  const labels = { devtest: 'Devtest', sbprod1: 'SB Prod-1', sbprod: 'SB Prod-2', sbprod3: 'SB Prod-3', sbprod4: 'SB Prod-4', harbinger: 'Harbinger-14', harbinger12: 'Harbinger-12' };
  $('#foot-controllers').innerHTML = [...controllers]
    .map((c) => `<span class="ctrl-chip ${down.has(c) ? 'down' : ''}"><span class="cdot"></span>${labels[c] || c}</span>`)
    .join('');
}

/* ---------- tabs ---------- */

function showView(tab) {
  activeTab = tab;
  $('#view-branches').hidden = tab !== 'branches';
  $('#view-cfds').hidden = tab !== 'cfds';
  $('#view-analytics').hidden = tab !== 'analytics';
  $('#view-cherry').hidden = tab !== 'cherry';
  $('#page-title').textContent = VIEW_TITLE[tab] || tab;
  $('#crumb-branch').textContent = tab === 'branches' ? 'master' : (VIEW_TITLE[tab] || tab).toLowerCase();
  $('#title-actions').hidden = tab !== 'branches';
}

function renderActiveTab(data) {
  if (activeTab === 'branches') {
    renderKpis(data);
    renderTimeline(data);
  }
}

function initTabs() {
  $$('.nav-tab').forEach((t) => {
    t.addEventListener('click', () => {
      $$('.nav-tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      showView(t.dataset.tab);
      if (lastData) renderActiveTab(lastData);
    });
  });
  const crumb = $('#crumb-root');
  if (crumb) {
    crumb.addEventListener('click', () => {
      $$('.nav-tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'branches'));
      showView('branches');
      if (lastData) renderActiveTab(lastData);
    });
  }
}

/* ---------- main render ---------- */

function showLoadError(err) {
  const msg = err && err.message ? err.message : String(err || 'unknown error');
  const rows = $('#rows');
  if (rows) {
    rows.innerHTML = `<div class="tab-empty">Could not load pipelines: ${msg}<br/><span class="todo-hint">Hard-refresh the page (Ctrl+Shift+R) if this persists.</span></div>`;
  }
  const kpi = $('#kpi-strip');
  if (kpi) kpi.innerHTML = `<div class="loading-inline">Could not load KPIs: ${msg}</div>`;
}

function render(data) {
  lastData = data;
  const loading = $('#loading');
  if (loading) loading.remove();
  const kloading = $('#kpi-loading');
  if (kloading) kloading.remove();
  renderMeta(data);
  renderActiveTab(data);
}

async function tick() {
  try {
    const data = await fetchSnapshot();
    render(data);
  } catch (e) {
    console.error('fetch/render failed', e);
    showLoadError(e);
  }
}

function init() {
  const refresh = $('#btn-refresh');
  const expand = $('#expand-all');
  const search = $('#search');
  if (refresh) refresh.addEventListener('click', triggerRefresh);
  if (expand) expand.addEventListener('click', toggleExpandAll);
  if (search) {
    search.addEventListener('input', (e) => {
      searchTerm = e.target.value.trim().toLowerCase();
      if (lastData) renderTimeline(lastData);
    });
  }
  initTabs();
  showView('branches');
  tick();
  setInterval(tick, REFRESH_MS);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
