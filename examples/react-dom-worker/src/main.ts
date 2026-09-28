/**
 * The shell — main-thread orchestration for the islands demo.
 *
 * Seven islands render on this page, each inside its OWN Web Worker (one
 * connectWorker client per island, pooling disabled — see island.ts for why
 * pooling can't go wider). Four run reconciled React trees out of the
 * registry worker ('charts' is real recharts rendering namespaced SVG);
 * 'vanilla' and 'map' run on dedicated REALM workers (defineRealmWorker —
 * the 1:1 topology): 'vanilla' is a purely IMPERATIVE app on the worker-side
 * proxy DOM, 'map' a REAL unmodified Leaflet 1.9 on proxy DOM + DOM shim —
 * and neither worker's bundle carries the React apps. Two islands run the
 * SAME 'data-table' app — a microfrontend isn't limited to one instance.
 * The shell:
 *
 *   - creates the layout + per-island containers and badges,
 *   - mounts one registry app per island via mountIsland(),
 *   - mediates island → island traffic through `onEvent` + `updateProps`:
 *       controls emits filterChanged/sortChanged → table.updateProps(...)
 *       table emits rowsChanged → stats.updateProps({visible, total})
 *       both tables emit rowSelected / controls emits countChanged → status line
 *
 * There is still NO React on this thread — every visible element below the
 * toolbar arrives via op replay. The whole islands pattern lives in
 * @jwhenry123/mesh-worker-dom; this file supplies the worker entrypoint and
 * the mediation glue.
 */
import {
  connectIslandWorker,
  mountIsland,
  type IslandHandle,
  type Mode,
} from '@jwhenry123/mesh-worker-dom';
// Leaflet's stylesheet is shell-side: the worker fabricates the DOM Leaflet
// builds (panes, tiles, controls) but CSS was always the shell's job.
import 'leaflet/dist/leaflet.css';

/** One fresh worker per island — poolSize is pinned to 1 inside connectIslandWorker. */
const islandWorker = (): Worker =>
  new Worker(new URL('./worker/render.worker.ts', import.meta.url), { type: 'module' });
// The imperative islands run dedicated realm workers (defineRealmWorker —
// 1:1 script per app): their bundles carry no React at all.
const vanillaWorker = (): Worker =>
  new Worker(new URL('./worker/vanilla.worker.ts', import.meta.url), { type: 'module' });
const mapWorker = (): Worker =>
  new Worker(new URL('./worker/map.worker.ts', import.meta.url), { type: 'module' });

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root missing from index.html');
const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el;
};

/* ── Shell state + status line ──────────────────────────────────────────── */

const state = { filter: '', desc: false };
const islands: IslandHandle[] = [];
let mode: Mode = 'push';

const statusEl = $('status-line');
const setStatus = (msg: string): void => {
  statusEl.textContent = msg;
};

/* ── Transport toolbar (global — drives every island's mode) ────────────── */

const pushBtn = $('push-btn') as HTMLButtonElement;
const pollBtn = $('poll-btn') as HTMLButtonElement;
const statsEl = $('transport-stats');

function renderStats(): void {
  pushBtn.style.fontWeight = mode === 'push' ? '700' : '400';
  pollBtn.style.fontWeight = mode === 'poll' ? '700' : '400';
  const flushes = islands.reduce((a, i) => a + i.flushCalls, 0);
  const ops = islands.reduce((a, i) => a + i.opsApplied, 0);
  statsEl.textContent = `sync: ${mode} · flush calls: ${flushes} · ops applied: ${ops}`;
}

function setMode(next: Mode): void {
  mode = next;
  // setMode after all mounts — the doorbell binds lazily (see island.ts).
  for (const island of islands) island.setMode(next);
  renderStats();
}

pushBtn.onclick = () => setMode('push');
pollBtn.onclick = () => setMode('poll');

/* ── Transclusion demo: a live canvas the SHELL owns inside a worker tree ─ */

/** Draw a rolling waveform into a slot element — real DOM, real rAF, no ops. */
let sparkRaf: number | undefined;
function mountSparkline(el: HTMLElement | null): void {
  if (sparkRaf !== undefined) cancelAnimationFrame(sparkRaf);
  sparkRaf = undefined;
  if (el === null) return; // unmounted by the worker tree — stop drawing

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100%;height:100%;display:block;border-radius:4px;background:#0d1117';
  el.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;
  const trace: number[] = [];
  const tick = (t: number): void => {
    const w = (canvas.width = el.clientWidth);
    const h = (canvas.height = el.clientHeight);
    trace.push((Math.sin(t / 320) + Math.sin(t / 97) * 0.5) / 1.5);
    if (trace.length > w) trace.shift();
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    trace.forEach((v, i) => {
      const y = h / 2 + v * h * 0.4;
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    });
    ctx.stroke();
    sparkRaf = requestAnimationFrame(tick);
  };
  sparkRaf = requestAnimationFrame(tick);
}

/* ── Boot ───────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  // Mount order: stats first so the table's initial rowsChanged emit has a
  // listener, then table, then controls (its events only travel outward).
  const stats = await mountIsland({
    client: connectIslandWorker({ worker: islandWorker }),
    el: $('island-stats'),
    app: 'stats',
    props: { visible: 2000, total: 2000, spark: 'wave' },
    slots: { wave: mountSparkline },
    onActivity: renderStats,
  });
  islands.push(stats);
  $('badge-stats').textContent = `worker ${stats.pid}`;

  const table = await mountIsland({
    client: connectIslandWorker({ worker: islandWorker }),
    el: $('island-table'),
    app: 'data-table',
    props: { filter: state.filter, desc: state.desc },
    onEvent: (name, payload) => {
      const p = payload as { count?: number; id?: number };
      // The shell mediates: one island's emit becomes another's props.
      if (name === 'rowsChanged') void stats.updateProps({ visible: p.count ?? 0, total: 2000 });
      if (name === 'rowSelected') setStatus(`table island emitted rowSelected → shell (row #${p.id})`);
    },
    onActivity: renderStats,
  });
  islands.push(table);
  $('badge-table').textContent = `worker ${table.pid}`;

  const controls = await mountIsland({
    client: connectIslandWorker({ worker: islandWorker }),
    el: $('island-controls'),
    app: 'controls',
    onEvent: (name, payload) => {
      const p = payload as { filter?: string; desc?: boolean; count?: number };
      if (name === 'filterChanged') {
        state.filter = p.filter ?? '';
        void table.updateProps({ filter: state.filter, desc: state.desc });
        setStatus(`controls emitted filterChanged → table.updateProps("${state.filter}")`);
      }
      if (name === 'sortChanged') {
        state.desc = p.desc ?? false;
        void table.updateProps({ filter: state.filter, desc: state.desc });
        setStatus(`controls emitted sortChanged → table.updateProps(desc=${state.desc})`);
      }
      if (name === 'countChanged') setStatus(`controls island counter → ${p.count} (state stayed in the worker)`);
    },
    onActivity: renderStats,
  });
  islands.push(controls);
  $('badge-controls').textContent = `worker ${controls.pid}`;

  // Multi-instance: the SAME microfrontend mounts again in a fourth worker —
  // islands aren't keyed by app name (each island is its own pool/worker), so
  // a microfrontend can appear any number of times with different content.
  // This copy starts filtered to eu-central and isn't wired into stats —
  // its emits still work, they just only reach this island's onEvent sink.
  const table2 = await mountIsland({
    client: connectIslandWorker({ worker: islandWorker }),
    el: $('island-table-2'),
    app: 'data-table',
    props: { filter: 'eu-central', desc: true },
    onEvent: (name, payload) => {
      const p = payload as { id?: number };
      if (name === 'rowSelected')
        setStatus(`second data-table instance emitted rowSelected (row #${p.id})`);
    },
    onActivity: renderStats,
  });
  islands.push(table2);
  $('badge-table-2').textContent = `worker ${table2.pid}`;

  // The imperative island — the 'vanilla' registry entry isn't a component,
  // it's build(doc) over the worker-side proxy DOM. Mount, events, and emit
  // all ride the same protocol; the worker just holds no React.
  const vanilla = await mountIsland({
    client: connectIslandWorker({ worker: vanillaWorker }),
    el: $('island-vanilla'),
    app: 'vanilla',
    props: { title: 'vanilla island — imperative proxy DOM, zero React in this worker' },
    onEvent: (name, payload) => {
      const p = payload as { color?: string; x?: number; y?: number };
      if (name === 'colorPicked') {
        setStatus(`vanilla island emitted colorPicked → ${p.color} @ (${p.x}, ${p.y})`);
      }
    },
    onActivity: renderStats,
  });
  islands.push(vanilla);
  $('badge-vanilla').textContent = `worker ${vanilla.pid}`;

  // The map island — REAL Leaflet 1.9, unmodified from npm, mounted on the
  // worker-side proxy DOM after installDomShim(). Tiles, panes, controls,
  // drag-pan and wheel zoom all work through the op stream; the only thing
  // shell-side is the stylesheet (imported above) and tile <img> loading.
  const map = await mountIsland({
    client: connectIslandWorker({ worker: mapWorker }),
    el: $('island-map'),
    app: 'map',
    onEvent: (name, payload) => {
      const p = payload as { label?: string; name?: string; zoom?: number };
      if (name === 'markerClicked') setStatus(`map island emitted markerClicked → ${p.label}`);
      if (name === 'placeSelected') setStatus(`map island emitted placeSelected → ${p.name}`);
      if (name === 'zoomChanged') setStatus(`map island emitted zoomChanged → zoom ${p.zoom}`);
    },
    onActivity: renderStats,
  });
  islands.push(map);
  $('badge-map').textContent = `worker ${map.pid}`;

  // The charts island — real recharts 3.x (unmodified) rendering an SVG
  // tree inside the worker. Fixed dimensions are passed as props because
  // ResponsiveContainer's container measurement has no channel in the
  // worker (the geometry caveat) — the shell just reads its own layout.
  const charts = await mountIsland({
    client: connectIslandWorker({ worker: islandWorker }),
    el: $('island-charts'),
    app: 'charts',
    props: { width: 600, height: 260 },
    onEvent: (name, payload) => {
      const p = payload as { region?: string; incidents?: number };
      if (name === 'chartClicked')
        setStatus(`charts island emitted chartClicked → ${p.region} (${p.incidents} incidents)`);
    },
    onActivity: renderStats,
  });
  islands.push(charts);
  $('badge-charts').textContent = `worker ${charts.pid}`;

  setMode('push');
  setStatus('seven islands mounted — two share an app, one runs no React, one runs real Leaflet + recharts');
}

void main();
