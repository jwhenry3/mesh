/**
 * The React shell — the same seven-island page as index.html, but the shell
 * itself is a React app mounting islands through `<Island/>`
 * (@jwhenry123/mesh-react-island).
 *
 * What changes versus main.ts:
 *   - Every island mounts through a `lazyIsland` proxy — the worker app
 *     types like a LOCAL component (`<TableIsland filter={f}/>`), each
 *     dynamic import is a code-split boundary covered by <Suspense>, and
 *     the `fallback` prop covers the worker-mount window.
 *   - Mediation is real data flow: a controls emit is setState, the table's
 *     props are that state — the component's updateProps call replaces the
 *     hand-wired `table.updateProps(...)` (and dedups repeats).
 *   - setMode/badges/stats ride ordinary React state + a handles map.
 *
 * The islands themselves are unchanged — the demo proves the op protocol
 * serves both shell styles: framework-free (index.html) and React.
 */
import { useEffect, useMemo, useRef, useState, Suspense } from 'react';
import type { ReactElement, ReactNode, RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import { lazyIsland } from '@jwhenry123/mesh-react-island';
import { connectIslandWorker } from '@jwhenry123/mesh-worker-dom';
import type { IslandHandle, Mode } from '@jwhenry123/mesh-worker-dom';
// Leaflet's stylesheet is shell-side: the worker fabricates the DOM Leaflet
// builds but CSS was always the shell's job.
import 'leaflet/dist/leaflet.css';

/** The registry worker — one script serving all four React apps. */
const renderWorker = (): Worker =>
  new Worker(new URL('./worker/render.worker.ts', import.meta.url), { type: 'module' });
// The imperative islands run dedicated realm workers (defineRealmWorker —
// the 1:1 topology): their bundles carry no React or reconciler at all.
const vanillaWorker = (): Worker =>
  new Worker(new URL('./worker/vanilla.worker.ts', import.meta.url), { type: 'module' });
const mapWorker = (): Worker =>
  new Worker(new URL('./worker/map.worker.ts', import.meta.url), { type: 'module' });

/*
 * Every island is a lazyIsland proxy — the worker app types like a LOCAL
 * component (props inline, no `props={}` nesting). Each dynamic import is a
 * bundler split point: the worker-side modules (recharts, leaflet, the
 * proxy-DOM imperative apps) only fetch when that island mounts, and
 * <Suspense> covers the load while `fallback` covers the mount window.
 */
const ControlsIsland = lazyIsland(() =>
  import('./worker/apps').then((m) => ({ default: m.ControlsApp })),
);
const TableIsland = lazyIsland(() =>
  import('./worker/apps').then((m) => ({ default: m.TableApp })),
);
const StatsIsland = lazyIsland(() =>
  import('./worker/apps').then((m) => ({ default: m.StatsApp })),
);
const ChartsIsland = lazyIsland(() =>
  import('./worker/apps').then((m) => ({ default: m.ChartsApp })),
);
const VanillaIsland = lazyIsland(() =>
  import('./worker/vanilla').then((m) => ({ default: m.vanillaApp })),
);
const MapIsland = lazyIsland(() =>
  import('./worker/map').then((m) => ({ default: m.mapApp })),
);

const loading = (
  <div className="island-root" style={{ color: '#7d8a9c' }}>
    loading worker module…
  </div>
);

/* ── Transclusion demo: a live canvas the SHELL owns inside a worker tree ─ */

function Sparkline(): ReactElement {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    let raf: number;
    const trace: number[] = [];
    const tick = (t: number): void => {
      const el = canvas.parentElement;
      const w = (canvas.width = el?.clientWidth ?? 300);
      const h = (canvas.height = el?.clientHeight ?? 150);
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
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <canvas
      ref={ref}
      style={{
        width: '100%',
        height: '100%',
        display: 'block',
        borderRadius: 4,
        background: '#0d1117',
      }}
    />
  );
}

/* ── Shell ──────────────────────────────────────────────────────────────── */

function IslandPanel(props: {
  title: string;
  badge?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="island">
      <div className="island-head">
        <span>{props.title}</span>
        <span className="badge">{props.badge ?? 'worker …'}</span>
      </div>
      {props.children}
    </section>
  );
}

export function Shell({ worker = renderWorker }: { worker?: () => Worker }): ReactElement {
  // Mediation state — controls emit → state → props on other islands.
  const [filter, setFilter] = useState('');
  const [desc, setDesc] = useState(false);
  const [visible, setVisible] = useState(2000);
  const [status, setStatus] = useState('mounting islands…');
  const [mode, setModeState] = useState<Mode>('push');
  const [pids, setPids] = useState<Record<string, string>>({});
  const [statsTick, setStatsTick] = useState(0);

  /** Every mounted island's handle — setMode + the aggregate stats read them. */
  const handles = useRef(new Map<string, IslandHandle>());
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // MULTI-ISLAND-PER-WORKER: one client = one worker. Both data-table
  // islands mount their realms into it ('data-table@N' keys — separate
  // reconcilers, op queues, and pids in ONE OS thread). The complex-
  // architecture counterpoint to the realm workers map/vanilla run on.
  const tableClient = useMemo(() => connectIslandWorker({ worker }), [worker]);

  const ready = (key: string) => (h: IslandHandle): void => {
    handles.current.set(key, h);
    h.setMode(modeRef.current); // doorbell binds lazily — set on ready
    setPids((p) => ({ ...p, [key]: `worker ${h.pid}` }));
    setStatsTick((t) => t + 1);
  };
  const bump = (): void => setStatsTick((t) => t + 1);

  useEffect(() => {
    for (const h of handles.current.values()) h.setMode(mode);
    bump();
  }, [mode]);

  const slots = useMemo(() => ({ wave: <Sparkline key="sparkline" /> }), []);
  const flushes = [...handles.current.values()].reduce((a, i) => a + i.flushCalls, 0);
  const ops = [...handles.current.values()].reduce((a, i) => a + i.opsApplied, 0);
  void statsTick; // re-render trigger for the aggregate read

  return (
    <>
      <h1>React islands — React shell edition</h1>
      <p style={{ font: '12px monospace', color: '#9aa4b2', marginTop: -8 }}>
        registry worker + realm workers + one shared client — the shell is React +{' '}
        <code>{'<Island/>'}</code>.{' '}
        <a href="/" style={{ color: '#7fb6ff' }}>framework-free shell →</a>
      </p>
      <div id="transport-bar">
        <span>transport:</span>
        <button
          id="push-btn"
          style={{ fontWeight: mode === 'push' ? 700 : 400 }}
          onClick={() => setModeState('push')}
        >
          push (SAB doorbell)
        </button>
        <button
          id="poll-btn"
          style={{ fontWeight: mode === 'poll' ? 700 : 400 }}
          onClick={() => setModeState('poll')}
        >
          poll (50ms)
        </button>
        <span id="transport-stats">
          sync: {mode} · flush calls: {flushes} · ops applied: {ops}
        </span>
      </div>
      <div id="status-line">{status}</div>

      <IslandPanel title="app: controls" badge={pids.controls}>
        <Suspense fallback={loading}>
          <ControlsIsland
            worker={renderWorker}
            containerProps={{ className: 'island-root' }}
            onReady={ready('controls')}
            onActivity={bump}
            onEvent={(name, payload) => {
            const p = payload as { filter?: string; desc?: boolean; count?: number };
            if (name === 'filterChanged') {
              setFilter(p.filter ?? '');
              setStatus(`controls emitted filterChanged → table props.filter="${p.filter}"`);
            }
            if (name === 'sortChanged') {
              setDesc(p.desc ?? false);
              setStatus(`controls emitted sortChanged → table props.desc=${p.desc}`);
            }
            if (name === 'countChanged')
              setStatus(`controls island counter → ${p.count} (state stayed in the worker)`);
          }}
          />
        </Suspense>
      </IslandPanel>

      <IslandPanel title="app: data-table (shares a worker with the second instance)" badge={pids.table}>
        <Suspense fallback={loading}>
        <TableIsland
          client={tableClient}
          // The mediation IS this line — controls' emits land as props here.
          filter={filter}
          desc={desc}
          containerProps={{ className: 'island-root', id: 'island-table' }}
          onReady={ready('table')}
          onActivity={bump}
          onEvent={(name, payload) => {
            const p = payload as { count?: number; id?: number };
            if (name === 'rowsChanged') setVisible(p.count ?? 0);
            if (name === 'rowSelected')
              setStatus(`table island emitted rowSelected → shell (row #${p.id})`);
          }}
        />
        </Suspense>
      </IslandPanel>

      <IslandPanel
        title="app: data-table (second realm — SAME worker as the first, one client)"
        badge={pids.table2}
      >
        <Suspense fallback={loading}>
        <TableIsland
          client={tableClient}
          filter="eu-central"
          desc
          containerProps={{ className: 'island-root', id: 'island-table-2' }}
          onReady={ready('table2')}
          onActivity={bump}
          onEvent={(name, payload) => {
            const p = payload as { id?: number };
            if (name === 'rowSelected')
              setStatus(`second data-table instance emitted rowSelected (row #${p.id})`);
          }}
        />
        </Suspense>
      </IslandPanel>

      <IslandPanel title="app: stats" badge={pids.stats}>
        <Suspense fallback={loading}>
          <StatsIsland
            worker={renderWorker}
            visible={visible}
            total={2000}
            spark="wave"
            slots={slots}
            containerProps={{ className: 'island-root' }}
            onReady={ready('stats')}
            onActivity={bump}
          />
        </Suspense>
      </IslandPanel>

      <IslandPanel
        title="app: vanilla (realm worker — its bundle has no React at all)"
        badge={pids.vanilla}
      >
        <Suspense fallback={loading}>
          <VanillaIsland
            worker={vanillaWorker}
            title="vanilla island — imperative proxy DOM, zero React in this worker"
            containerProps={{ className: 'island-root' }}
            onReady={ready('vanilla')}
            onActivity={bump}
            onEvent={(name, payload) => {
              const p = payload as { color?: string; x?: number; y?: number };
              if (name === 'colorPicked')
                setStatus(`vanilla island emitted colorPicked → ${p.color} @ (${p.x}, ${p.y})`);
            }}
          />
        </Suspense>
      </IslandPanel>

      <IslandPanel
        title="app: charts (real recharts — lazyIsland: suspends on the import, mounts by reference)"
        badge={pids.charts}
      >
        <Suspense
          fallback={<div className="island-root" style={{ color: '#7d8a9c' }}>loading charts…</div>}
        >
          <ChartsIsland
            worker={renderWorker}
            // Inline props — the same contract as the worker component.
            width={600}
            height={260}
            fallback={<div style={{ color: '#7d8a9c' }}>mounting worker…</div>}
            containerProps={{ className: 'island-root' }}
            onReady={ready('charts')}
            onActivity={bump}
            onEvent={(name, payload) => {
              const p = payload as { region?: string; incidents?: number };
              if (name === 'chartClicked')
                setStatus(
                  `charts island emitted chartClicked → ${p.region} (${p.incidents} incidents)`,
                );
            }}
          />
        </Suspense>
      </IslandPanel>

      <IslandPanel
        title="app: map (realm worker — real Leaflet 1.9, no React in the bundle)"
        badge={pids.map}
      >
        <Suspense fallback={loading}>
          <MapIsland
            worker={mapWorker}
            containerProps={{ className: 'island-root', id: 'island-map' }}
            onReady={ready('map')}
            onActivity={bump}
            onEvent={(name, payload) => {
              const p = payload as { label?: string; name?: string; zoom?: number };
              if (name === 'markerClicked')
                setStatus(`map island emitted markerClicked → ${p.label}`);
              if (name === 'placeSelected')
                setStatus(`map island emitted placeSelected → ${p.name}`);
              if (name === 'zoomChanged')
                setStatus(`map island emitted zoomChanged → zoom ${p.zoom}`);
            }}
          />
        </Suspense>
      </IslandPanel>
    </>
  );
}

// Guarded so the module is import-safe in tests (they render <Shell/> directly).
const rootEl = document.getElementById('root');
if (rootEl) createRoot(rootEl).render(<Shell />);
