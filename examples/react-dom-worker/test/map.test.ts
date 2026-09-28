// @vitest-environment happy-dom
/**
 * Real Leaflet 1.9 (unmodified from npm) running inside a worker island on
 * the proxy DOM — the hardest DOM-dependent library we could point at the
 * shim. Verifies: mount, tile <img> ops, divIcon markers, zoom controls,
 * attribution, delegated marker clicks, control clicks, drag-pan, and
 * wheel zoom — all with zero Leaflet code on the main thread.
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
InProcessWorker.handlerModules = [() => import('../src/worker/map.worker')];

let connectIslandWorker: typeof import('@jwhenry123/mesh-worker-dom').connectIslandWorker;
let mountIsland: typeof import('@jwhenry123/mesh-worker-dom').mountIsland;
beforeAll(async () => {
  ({ connectIslandWorker, mountIsland } = await import('@jwhenry123/mesh-worker-dom'));
});

const islandClient = () =>
  connectIslandWorker({
    worker: () =>
      new Worker(new URL('../src/worker/map.worker.ts', import.meta.url), { type: 'module' }),
  });

const fire = (el: Element, event: Event): void => {
  el.dispatchEvent(event);
};
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('leaflet map island', () => {
  it('mounts real Leaflet — tiles, markers, controls, attribution', async () => {
    const prevDoc = (globalThis as any).document;
    const prevWin = (globalThis as any).window;
    const prevElement = (globalThis as any).Element;
    try {
      const el = document.createElement('div');
      Object.defineProperty(el, 'clientWidth', { value: 640, configurable: true });
      Object.defineProperty(el, 'clientHeight', { value: 420, configurable: true });
      document.body.appendChild(el);

      const emitted: Array<{ name: string; payload: unknown }> = [];
      const island = await mountIsland({
        client: islandClient(),
        el,
        app: 'map',
        onEvent: (name, payload) => emitted.push({ name, payload }),
      });
      island.setMode('push');

      await vi.waitFor(
        async () => {
          await island.flush();
          expect(el.classList.contains('leaflet-container')).toBe(true);
        },
        { timeout: 10000 },
      );
      await island.flush();

      // Leaflet's own DOM arrived as ops — tiles, pins, controls, attribution.
      expect(el.querySelectorAll('img.leaflet-tile').length).toBeGreaterThan(0);
      expect(el.querySelectorAll('.mesh-map-pin').length).toBe(3);
      expect(el.querySelectorAll('.leaflet-control-zoom a').length).toBe(2);
      expect(el.querySelectorAll('.mesh-map-place-btn').length).toBe(3);
      expect(el.querySelector('.leaflet-control-attribution')?.textContent)
        .toContain('OpenStreetMap');

      // ── marker click → routed through the map's delegated _targets table
      //    → emit reaches the shell. Clicks go BEFORE any drag: Leaflet
      //    suppresses a click that follows a real drag (_draggableMoved),
      //    which is correct behavior, not a proxy-DOM gap.
      const pin = el.querySelector('.mesh-map-pin')!;
      fire(pin, new MouseEvent('click', { bubbles: true }));
      await vi.waitFor(async () => {
        await island.flush();
        expect(emitted.some((e) => e.name === 'markerClicked')).toBe(true);
      });
      expect(emitted.find((e) => e.name === 'markerClicked')?.payload)
        .toMatchObject({ id: 'paris', label: 'Paris' });

      // ── custom control (place picker) → setView + emit.
      fire(el.querySelector('.mesh-map-place-btn')!, new MouseEvent('click', { bubbles: true }));
      await vi.waitFor(async () => {
        await island.flush();
        expect(emitted.some((e) => e.name === 'placeSelected')).toBe(true);
      });
      expect(emitted.find((e) => e.name === 'placeSelected')?.payload)
        .toMatchObject({ name: 'Lisbon' });

      // ── drag-pan: Leaflet registers document-level move/up listeners
      //    INSIDE the mousedown dispatch — they only exist main-thread once
      //    that dispatch's `listen` ops land. A real drag fires many moves
      //    (a dropped first move is invisible); the test settles the
      //    registration round-trip, then keeps moving until the pane shifts.
      const pane = el.querySelector('.leaflet-map-pane')! as HTMLElement;
      const paneBefore = pane.style.left;
      fire(pane, new MouseEvent('mousedown', { bubbles: true, clientX: 320, clientY: 210, button: 0 }));
      await tick();
      await island.flush();
      await vi.waitFor(async () => {
        fire(pane, new MouseEvent('mousemove', { bubbles: true, clientX: 240, clientY: 160 }));
        await island.flush();
        expect(pane.style.left !== paneBefore || pane.style.transform !== '').toBe(true);
      });
      fire(pane, new MouseEvent('mouseup', { bubbles: true, clientX: 240, clientY: 160 }));
      await tick();
      await island.flush();

      // ── wheel zoom — deltaY payload feeds ScrollWheelZoom; the zoomend
      //    emit comes from Leaflet's debounce timer via runInRealm.
      for (const type of ['wheel', 'mousewheel']) {
        fire(pane, new WheelEvent(type, { bubbles: true, deltaY: -240 }));
      }
      await vi.waitFor(async () => {
        await island.flush();
        expect(emitted.some((e) => e.name === 'zoomChanged')).toBe(true);
      }, { timeout: 8000 });

      // Let Leaflet's debounced wheel-zoom and drag-inertia timers fire
      // before teardown — in-process workers share the test thread, so a
      // delayed callback that fires after destroy hits a disposed proxy DOM.
      await tick(300);

      island.destroy();
    } finally {
      (globalThis as any).document = prevDoc;
      (globalThis as any).window = prevWin;
      (globalThis as any).Element = prevElement;
    }
  });
});
