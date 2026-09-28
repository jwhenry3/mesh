// @vitest-environment happy-dom
/**
 * Recharts island E2E — real recharts 3.x (unmodified) rendering an SVG
 * tree inside a worker island. The point of the test: <svg>/<path>/<text>
 * must arrive in the SVG namespace via the host-context plumbing (plain
 * createElement would produce HTMLUnknownElements), and a recharts Bar
 * onClick — invoked internally by the library on a real DOM click — must
 * round-trip into the island's emit channel.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { InProcessWorker } from '../../../test/inProcessWorker';

const requireFromRoot = async () => {
  const { createRequire } = await import('node:module');
  const { join } = await import('node:path');
  return createRequire(join(process.cwd(), 'package.json'));
};
vi.mock('react', async () => {
  const mod = (await requireFromRoot())('react') as Record<string, unknown>;
  return { ...mod, default: mod };
});
vi.mock('react/jsx-runtime', async () => {
  const mod = (await requireFromRoot())('react/jsx-runtime') as Record<string, unknown>;
  return { ...mod, default: mod };
});

vi.stubGlobal('Worker', InProcessWorker);
InProcessWorker.handlerModules = [() => import('../src/worker/render.worker')];

let connectIslandWorker: typeof import('@jwhenry123/mesh-worker-dom').connectIslandWorker;
let mountIsland: typeof import('@jwhenry123/mesh-worker-dom').mountIsland;
beforeAll(async () => {
  ({ connectIslandWorker, mountIsland } = await import('@jwhenry123/mesh-worker-dom'));
});

const islandClient = () =>
  connectIslandWorker({
    worker: () =>
      new Worker(new URL('../src/worker/render.worker.ts', import.meta.url), { type: 'module' }),
  });

const SVG_NS = 'http://www.w3.org/2000/svg';

describe('recharts island', () => {
  it('renders namespaced SVG and round-trips a bar click', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const emitted: Array<{ name: string; payload: unknown }> = [];

    const island = await mountIsland({
      client: islandClient(),
      el,
      app: 'charts',
      props: { width: 600, height: 260 },
      onEvent: (name, payload) => emitted.push({ name, payload }),
    });
    island.setMode('push');
    // Recharts does multi-pass measurement renders after mount — the commits
    // queue from passive effects and converge after a few flushes.
    await vi.waitFor(async () => {
      await island.flush();
      expect(el.querySelector('svg')).not.toBeNull();
      expect(el.querySelectorAll('.recharts-bar-rectangle path, .recharts-rectangle').length).toBe(5);
    });

    // ── Namespace: the whole chart is REAL SVG, not HTMLUnknownElements —
    //    every create op inside <svg> carried the svg ns. (querySelector picks
    //    the chart surface — recharts legend icons are separate 14px svgs.)
    const svg = el.querySelector('svg.recharts-surface')!;
    expect(svg).not.toBeNull();
    expect(svg.namespaceURI).toBe(SVG_NS);
    expect(el.querySelectorAll(`${'svg'} path`).length).toBeGreaterThan(0);
    for (const node of el.querySelectorAll('path, text, line, rect, g')) {
      if (node.namespaceURI !== SVG_NS) {
        // eslint-disable-next-line no-console
        console.log('XHTML offender:', node.tagName, node.getAttribute('class'), node.parentElement?.tagName, node.parentElement?.getAttribute('class'));
      }
      expect(node.namespaceURI).toBe(SVG_NS);
    }

    // ── Recharts internals all landed: grid lines, axis ticks, bars, the
    //    line series' path, legend markup (HTML, outside the svg).
    expect(el.querySelectorAll('.recharts-cartesian-grid line').length).toBeGreaterThan(0);
    // recharts 3 splits ticks: ...-tick groups hold the line, ...-tick-label
    // groups hold the text.
    expect(el.querySelectorAll('.recharts-cartesian-axis-tick-label text').length).toBeGreaterThan(0);
    const bars = el.querySelectorAll('.recharts-bar-rectangle path, .recharts-rectangle');
    expect(bars.length).toBe(5);
    expect(el.querySelectorAll('.recharts-line path.recharts-curve, path.recharts-curve').length)
      .toBeGreaterThan(0);
    expect(el.querySelector('.recharts-legend-wrapper')).not.toBeNull();
    // HTML wrappers outside the svg stay HTML-namespaced.
    expect(el.querySelector('.recharts-wrapper')!.namespaceURI)
      .toBe('http://www.w3.org/1999/xhtml');

    // ── Bar click → recharts' internal onClick adapter fires inside the
    //    dispatch → our emit reaches the shell with the datum.
    const bar = bars[0];
    bar.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(async () => {
      await island.flush();
      expect(emitted.some((e) => e.name === 'chartClicked')).toBe(true);
    });
    expect(emitted.find((e) => e.name === 'chartClicked')?.payload)
      .toMatchObject({ region: 'us-east', incidents: 418 });

    island.destroy();
  });
});
