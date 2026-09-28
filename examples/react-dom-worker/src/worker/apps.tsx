/**
 * The island apps — each runs inside its own Web Worker.
 *
 * Everything here is ordinary React: hooks, memo, controlled inputs. The only
 * rules for worker-side components are no DOM access (no document/window/refs)
 * and serializable props (they cross postMessage when the shell calls
 * updateProps). Event handlers receive the plain { type, value, checked, key }
 * payload the main thread sends back, not a SyntheticEvent.
 *
 * Island → shell communication is `emit(name, payload)` — it queues an `emit`
 * op the shell's onEvent callback receives. Call it inside handlers or
 * commit-phase effects (useLayoutEffect), where a task is holding the realm.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { emit, islandApp, Slot, type EventPayload } from '@jwhenry123/mesh-worker-dom/worker';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

/**
 * Worker-side event handlers receive the plain wire payload — { type, value,
 * checked, key } — not a SyntheticEvent. `handler()` adapts them to the DOM
 * event prop types JSX expects; the cast is the whole story, nothing wraps
 * at runtime.
 */
const handler = <E,>(fn: (e: EventPayload) => void): ((e: E) => void) =>
  fn as unknown as (e: E) => void;

/* ── controls ───────────────────────────────────────────────────────────── */

/**
 * Filter input + sort toggle + counter — the islands' control surface.
 * Every control change is emitted to the shell; the counter is the demo's
 * "still alive" heartbeat (its state stays inside this worker).
 */
export const ControlsApp = islandApp('controls', function ControlsApp() {
  const [filter, setFilter] = useState('');
  const [desc, setDesc] = useState(false);
  const [count, setCount] = useState(0);

  const onFilter = useCallback((e: EventPayload) => {
    const next = e.value ?? '';
    setFilter(next);
    emit('filterChanged', { filter: next });
  }, []);
  const toggleSort = useCallback(() => {
    const next = !desc;
    setDesc(next);
    emit('sortChanged', { desc: next });
  }, [desc]);
  const bump = useCallback(() => {
    const next = count + 1;
    setCount(next);
    emit('countChanged', { count: next });
  }, [count]);

  return (
    <section>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', margin: '8px 0' }}>
        <input
          type="text"
          placeholder="filter table (site, region, severity)…"
          value={filter}
          onInput={handler(onFilter)}
          style={{ flex: 1 }}
        />
        <button onClick={handler(toggleSort)}>sort: {desc ? 'desc' : 'asc'}</button>
      </div>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
        <button onClick={handler(bump)}>count: {count}</button>
        <span style={{ color: '#9aa4b2', fontSize: '13px' }}>
          every change above is emit()'d to the shell — the table island re-renders
          via updateProps
        </span>
      </div>
    </section>
  );
});

/* ── data-table ─────────────────────────────────────────────────────────── */

interface RowData {
  id: number;
  site: string;
  region: string;
  severity: number;
  incidents: number;
}

const ROW_COUNT = 2000;
const REGIONS = ['us-east', 'us-west', 'eu-central', 'ap-south', 'sa-east'];
const SEVERITIES = ['P1', 'P2', 'P3', 'P4'];

// Deterministic pseudo-data so every mount renders the same 2000 rows.
const DATA: RowData[] = Array.from({ length: ROW_COUNT }, (_, i) => ({
  id: i,
  site: `site-${(i * 7919) % 1409}`,
  region: REGIONS[i % REGIONS.length],
  severity: (i * 31) % 100,
  incidents: (i * 104729) % 977,
}));

const Row = memo(function Row({
  row,
  selected,
  onPick,
}: {
  row: RowData;
  selected: boolean;
  onPick: (id: number) => void;
}) {
  return (
    <tr
      onClick={handler(() => onPick(row.id))}
      style={selected ? { background: '#22354f', cursor: 'pointer' } : { cursor: 'pointer' }}
    >
      <td>{row.id}</td>
      <td>{row.site}</td>
      <td>{row.region}</td>
      <td>
        <span
          style={{
            display: 'inline-block',
            padding: '1px 8px',
            borderRadius: '8px',
            fontSize: '12px',
            background: row.severity > 75 ? '#7d2b2b' : row.severity > 40 ? '#6f5a1e' : '#1f4d2e',
          }}
        >
          {SEVERITIES[row.severity % SEVERITIES.length]} · {row.severity}
        </span>
      </td>
      <td>{row.incidents}</td>
    </tr>
  );
});

export interface TableProps {
  filter?: string;
  desc?: boolean;
}

/**
 * The 2000-row memoized table — its filter/sort arrive as PROPS from the
 * shell (the controls island emits them; the shell calls updateProps).
 * Emits `rowSelected` on click and `rowsChanged` whenever the visible set
 * changes — the shell feeds that count to the stats island.
 */
export const TableApp = islandApp('data-table', function TableApp({ filter = '', desc = false }: TableProps) {
  const [selected, setSelected] = useState<number | null>(null);

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const filtered =
      f === ''
        ? DATA
        : DATA.filter(
            (r) =>
              r.site.includes(f) ||
              r.region.includes(f) ||
              String(r.severity).startsWith(f) ||
              SEVERITIES[r.severity % SEVERITIES.length].toLowerCase() === f,
          );
    return [...filtered].sort((a, b) => (desc ? b.id - a.id : a.id - b.id));
  }, [filter, desc]);

  // Commit-phase effect — emit() here lands in the same op batch as the
  // render that produced these rows, so the shell's stats island always
  // hears the count that matches what's on screen.
  useLayoutEffect(() => {
    emit('rowsChanged', { count: rows.length });
  }, [rows.length]);

  const onPick = useCallback((id: number) => {
    setSelected(id);
    emit('rowSelected', { id });
  }, []);

  return (
    <section>
      <p style={{ margin: '4px 0 8px', color: '#9aa4b2', fontSize: '13px' }}>
        {rows.length} rows · filter {filter === '' ? '(none)' : `"${filter}"`} · sort{' '}
        {desc ? 'desc' : 'asc'}
        {selected !== null ? ` · selected #${selected}` : ''}
      </p>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>site</th>
            <th>region</th>
            <th>severity</th>
            <th>incidents</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Row key={row.id} row={row} selected={row.id === selected} onPick={onPick} />
          ))}
        </tbody>
      </table>
    </section>
  );
});

/* ── stats ──────────────────────────────────────────────────────────────── */

/** A visibly non-trivial calculation — runs on the worker's thread, so the
 *  page (and its CSS spinner) never stutters while it crunches. */
function busyCompute(seed: number): number {
  let acc = seed;
  for (let i = 1; i < 4_000_000; i++) {
    acc += Math.sqrt((acc * 1664525 + i * 1013904223) % 2147483647);
  }
  return Math.round(acc) % 100_000;
}

export interface StatsProps {
  visible?: number;
  total?: number;
  /** Slot name for the shell-owned sparkline panel; omit to render no slot. */
  spark?: string;
}

/**
 * Row-count readout + the busy-loop compute button. `visible`/`total` arrive
 * as props (fed by the table island's rowsChanged emit, via the shell).
 * The useEffect marker proves async commits still flush through the
 * per-island doorbell.
 */
export const StatsApp = islandApp('stats', function StatsApp({ visible = 0, total = 0, spark }: StatsProps) {
  const [computeSeed, setComputeSeed] = useState(1);
  const [effectRan, setEffectRan] = useState(false);

  // This state update commits AFTER mount — its ops arrive via the doorbell
  // (push) or the poll tick, never in a task's return batch.
  useEffect(() => {
    setEffectRan(true);
  }, []);

  const computeResult = useMemo(() => busyCompute(computeSeed), [computeSeed]);
  const runCompute = useCallback(() => setComputeSeed((s) => s + 1), []);

  return (
    <section>
      <p style={{ margin: '4px 0 8px' }}>
        showing <strong>{visible}</strong> / {total} rows ·{' '}
        <strong>{effectRan ? 'passive effects flushed ✓' : 'mounting…'}</strong>
      </p>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
        <button onClick={handler(runCompute)}>compute (busy loop in worker)</button>
        <span>
          compute result: <code>{computeResult}</code>
        </span>
      </div>
      {spark ? (
        <div>
          <p style={{ margin: '10px 0 4px', color: '#9aa4b2', fontSize: '12px' }}>
            ↓ transcluded slot — a canvas the SHELL draws into this worker-rendered tree
          </p>
          <Slot name={spark} style={{ height: '56px' }} />
        </div>
      ) : null}
    </section>
  );
});

/* ── charts (recharts) ──────────────────────────────────────────────────── */

interface RegionStat {
  region: string;
  incidents: number;
  resolved: number;
}

const CHART_DATA: RegionStat[] = [
  { region: 'us-east', incidents: 418, resolved: 372 },
  { region: 'us-west', incidents: 295, resolved: 261 },
  { region: 'eu-central', incidents: 356, resolved: 340 },
  { region: 'ap-south', incidents: 487, resolved: 398 },
  { region: 'sa-east', incidents: 171, resolved: 150 },
];

export interface ChartsProps {
  /** Real dimensions — ResponsiveContainer can't measure in the worker
   *  (no layout engine), so the shell passes measured pixels as props. */
  width?: number;
  height?: number;
}

/**
 * Real recharts 3.x (unmodified) rendering an SVG tree inside the worker —
 * the namespace plumbing demo: <svg>/<path>/<text> all arrive as
 * createElementNS ops via the host-context namespace tracking. A Bar's
 * onClick is invoked by recharts' own internals with the datum — inside a
 * dispatch's realm scope, so emit() routes normally. Fixed dims are
 * honest: ResponsiveContainer's getBoundingClientRect measurement has no
 * channel (see the geometry caveat), so the shell feeds measured size via
 * props instead.
 *
 * Stamped via islandApp('charts', …) so React shells can mount it by
 * reference — <Island app={ChartsApp} props={{ width }} /> — with props
 * inferred from ChartsProps and the registry key surviving minification.
 */
export const ChartsApp = islandApp('charts', function ChartsApp({ width = 600, height = 260 }: ChartsProps) {
  const [picked, setPicked] = useState<RegionStat | null>(null);

  return (
    <section>
      <p style={{ margin: '4px 0 8px', color: '#9aa4b2', fontSize: '13px' }}>
        recharts {`<ComposedChart>`} rendered as namespaced SVG ops — click a
        bar to emit; {picked ? `last pick: ${picked.region} (${picked.incidents})` : 'no pick yet'}
      </p>
      <ComposedChart width={width} height={height} data={CHART_DATA}>
        <CartesianGrid stroke="#2a3340" strokeDasharray="3 3" />
        <XAxis dataKey="region" stroke="#9aa4b2" fontSize={12} />
        <YAxis stroke="#9aa4b2" fontSize={12} />
        <Tooltip
          contentStyle={{ background: '#161c26', border: '1px solid #2a3340', fontSize: 12 }}
          labelStyle={{ color: '#e6edf3' }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar
          dataKey="incidents"
          fill="#2d6cdf"
          barSize={28}
          isAnimationActive={false}
          onClick={(data: unknown) => {
            const d = data as RegionStat;
            setPicked(d);
            emit('chartClicked', { region: d.region, incidents: d.incidents, resolved: d.resolved });
          }}
        />
        <Line
          type="monotone"
          dataKey="resolved"
          stroke="#3fb950"
          strokeWidth={2}
          dot={{ r: 3 }}
          isAnimationActive={false}
        />
      </ComposedChart>
    </section>
  );
});
