// @vitest-environment happy-dom
/**
 * Functional test for the islands demo — three mountIsland() trees over
 * InProcessWorker, so everything except the OS thread boundary is real:
 * the registry, per-realm reconcilers, the op protocol, the emit channel,
 * and the shared-memory doorbell. The islands runtime itself now lives in
 * @jwhenry123/mesh-worker-dom — this test exercises the same code through
 * the package's exports.
 *
 * One module instance plays every worker, so realms are keyed by app name —
 * exactly why mount/updateProps/flush/whoami carry the app on the wire.
 * A shared module graph also means every defined shared-memory contract ends
 * up bound to the LAST pool's buffer; doorbells therefore have to subscribe
 * after all mounts (island.ts documents the same call order for main.ts).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { InProcessWorker } from '../../../test/inProcessWorker';

/**
 * One React copy for the whole render stack. The suite aliases `react` to the
 * repo root's install, and react-reconciler (resolved at the root's
 * node_modules from packages/worker-dom) is externalized — Node-resolving the
 * ROOT's react. Re-point every 'react'/'react/jsx-runtime' import at that same
 * install (createRequire = the same require the externalized reconciler uses)
 * so apps, hostConfig, and reconciler share one instance — two copies would
 * null the hook dispatcher.
 */
const requireFromRoot = async () => {
  const { createRequire } = await import('node:module');
  const { join } = await import('node:path');
  // import.meta.url is a served http URL under the module runner — anchor at
  // the repo root (vitest cwd) instead.
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
// In-process workers share one module graph — every worker entry registers
// into it (defineIslandWorker's registry + the realm workers' single apps).
InProcessWorker.handlerModules = [
  () => import('../src/worker/render.worker'),
  () => import('../src/worker/vanilla.worker'),
  () => import('../src/worker/map.worker'),
];

let connectIslandWorker: typeof import('@jwhenry123/mesh-worker-dom').connectIslandWorker;
let mountIsland: typeof import('@jwhenry123/mesh-worker-dom').mountIsland;
beforeAll(async () => {
  // Imported after the Worker stub — the client factory builds pools lazily.
  ({ connectIslandWorker, mountIsland } = await import('@jwhenry123/mesh-worker-dom'));
});

/** One island client factory — the worker entry is this example's registry. */
const islandClient = () =>
  connectIslandWorker({
    worker: () =>
      new Worker(new URL('../src/worker/render.worker.ts', import.meta.url), { type: 'module' }),
  });

const fire = (el: Element, event: Event): void => {
  el.dispatchEvent(event);
};

describe('react-dom-worker islands', () => {
  it('mounts islands with distinct realms, mediates emit → updateProps, and flushes via the doorbell', async () => {
    const controlsEl = document.createElement('div');
    const tableEl = document.createElement('div');
    const statsEl = document.createElement('div');
    document.body.append(controlsEl, tableEl, statsEl);

    const emitted: Array<{ name: string; payload: unknown }> = [];

    // Same mediation as src/main.ts — controls → table, table → stats.
    const stats = await mountIsland({
      client: islandClient(),
      el: statsEl,
      app: 'stats',
      props: { visible: 2000, total: 2000 },
    });
    const table = await mountIsland({
      client: islandClient(),
      el: tableEl,
      app: 'data-table',
      props: { filter: '', desc: false },
      onEvent: (name, payload) => {
        emitted.push({ name, payload });
        const p = payload as { count?: number };
        if (name === 'rowsChanged') void stats.updateProps({ visible: p.count ?? 0, total: 2000 });
      },
    });
    const controls = await mountIsland({
      client: islandClient(),
      el: controlsEl,
      app: 'controls',
      onEvent: (name, payload) => {
        emitted.push({ name, payload });
        const p = payload as { filter?: string };
        if (name === 'filterChanged') void table.updateProps({ filter: p.filter ?? '', desc: false });
      },
    });

    /* distinct worker realms — the badge ids */
    expect(new Set([controls.pid, table.pid, stats.pid]).size).toBe(3);
    for (const pid of [controls.pid, table.pid, stats.pid]) expect(pid).toMatch(/^w-/);

    /* mount produced real DOM in each container */
    expect(controlsEl.querySelector('input')).not.toBeNull();
    expect(tableEl.querySelectorAll('tbody tr').length).toBe(2000);
    expect(statsEl.textContent).toContain('2000');

    /* island → shell → island: filter emits, table re-renders filtered rows */
    const input = controlsEl.querySelector('input')!;
    input.value = 'us-east';
    fire(input, new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(tableEl.querySelectorAll('tbody tr').length).toBe(400));
    expect(emitted.some((e) => e.name === 'filterChanged' && (e.payload as { filter: string }).filter === 'us-east')).toBe(true);

    /* the emit chain fed the stats island's props too */
    await vi.waitFor(() => expect(statsEl.textContent).toContain('400'));

    /* table emits rowSelected on click — island → shell, not a DOM op */
    fire(tableEl.querySelector('tbody tr')!, new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(emitted.some((e) => e.name === 'rowSelected')).toBe(true));

    /* doorbell: StatsApp's useEffect commits outside a task — its opsVersion
       bump (plus the subscription's initial-value emit) triggers flush() on
       its own. No manual island.flush() is ever called. */
    const flushesBefore = stats.flushCalls;
    for (const island of [controls, table, stats]) island.setMode('push');
    await vi.waitFor(() => expect(statsEl.textContent).toContain('passive effects flushed'));
    expect(stats.flushCalls).toBeGreaterThan(flushesBefore);
  });

  it('mount() on an already-mounted app remounts — fresh batch, same pid', async () => {
    const client = islandClient();
    const first = await client.mount('controls', {});
    const pid = await client.whoami('controls');
    expect(first.some((op) => op.t === 'create')).toBe(true);

    const second = await client.mount('controls', {});
    // Remount replays a clear + full create set onto the emptied root.
    expect(second.some((op) => op.t === 'clear')).toBe(true);
    expect(second.some((op) => op.t === 'create')).toBe(true);
    expect(await client.whoami('controls')).toBe(pid); // pid survives a remount
    client.terminate();
  });

  it('mount() rejects unknown registry apps', async () => {
    const client = islandClient();
    await expect(client.mount('nope', {})).rejects.toThrow(/unknown app "nope"/);
    client.terminate();
  });

  it('the same microfrontend mounts in multiple islands with independent content', async () => {
    // The islands model is per-worker, not per-app-name — nothing stops the
    // same registry app running in two islands at once, each with its own
    // worker, props, and rendered output.
    const elA = document.createElement('div');
    const elB = document.createElement('div');
    document.body.append(elA, elB);

    const a = await mountIsland({
      client: islandClient(),
      el: elA,
      app: 'data-table',
      props: { filter: 'us-east', desc: false },
    });
    const b = await mountIsland({
      client: islandClient(),
      el: elB,
      app: 'data-table',
      props: { filter: '', desc: true },
    });

    // Same app name, different workers.
    expect(a.pid).not.toBe(b.pid);
    expect(a.pid).toMatch(/^w-/);

    // Independent content: A rendered the filter passed at mount, B is
    // unfiltered and descending.
    expect(elA.querySelectorAll('tbody tr').length).toBe(400);
    expect(elB.querySelectorAll('tbody tr').length).toBe(2000);
    const aFirstCell = elA.querySelector('tbody tr td')!.textContent;
    const bFirstCell = elB.querySelector('tbody tr td')!.textContent;
    expect(aFirstCell).not.toBe(bFirstCell);

    // And each still reacts independently — updating A's props doesn't
    // touch B.
    await a.updateProps({ filter: '', desc: false });
    expect(elA.querySelectorAll('tbody tr').length).toBe(2000);
    expect(elB.querySelectorAll('tbody tr').length).toBe(2000);
    a.destroy();
    b.destroy();
  });

  it('transclusion: a data-mesh-slot element is handed to the shell, unmounted on removal', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);

    const mounted: HTMLElement[] = [];
    const unmounted: (null)[] = [];
    const island = await mountIsland({
      client: islandClient(),
      el,
      app: 'stats',
      props: { spark: 'wave' },
      slots: {
        wave: (node) => {
          if (node === null) unmounted.push(null);
          else {
            mounted.push(node);
            node.appendChild(document.createElement('canvas')); // shell-owned content
          }
        },
      },
    });

    // The slot element is real DOM inside the island's tree, marked so the
    // shell can find it — and its children are shell-owned (the worker tree
    // rendered a leaf).
    expect(mounted.length).toBe(1);
    const slotEl = mounted[0];
    expect(slotEl.getAttribute('data-mesh-slot')).toBe('wave');
    expect(el.contains(slotEl)).toBe(true);
    expect(slotEl.querySelector('canvas')).not.toBeNull();

    // Worker removes the slot (prop drops it from the tree) → shell teardown
    // fires with null, even though the remove op targeted the wrapper above it.
    await island.updateProps({ spark: undefined });
    await vi.waitFor(() => expect(unmounted.length).toBe(1));
    expect(el.contains(slotEl)).toBe(false);
    island.destroy();
  });

  it('vanilla island: an imperative proxy-DOM app builds real DOM and round-trips events', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const emitted: Array<{ name: string; payload: unknown }> = [];

    const island = await mountIsland({
      client: islandClient(),
      el,
      app: 'vanilla',
      props: { title: 'test vanilla widget' },
      onEvent: (name, payload) => emitted.push({ name, payload }),
    });
    expect(island.pid).toMatch(/^w-/);

    // Imperative-built DOM landed via the ordinary op stream — attr ops for
    // id/class/dataset, style ops for inline styles, text ops for content.
    expect(el.querySelector('#vanilla-root')).not.toBeNull();
    expect(el.querySelector('.vanilla-heading')!.textContent).toBe('test vanilla widget');
    const swatches = el.querySelectorAll('.swatch');
    expect(swatches.length).toBe(5);
    expect((swatches[0] as HTMLElement).style.background).not.toBe('');
    expect(swatches[0].getAttribute('data-color')).toBe('#2d6cdf');
    // The boot log lines were appended by imperative code reading its own
    // shadow tree (row.children.length / querySelectorAll / the shim check).
    const readout = el.querySelector('[data-role="readout"]')!;
    expect(readout.textContent).toContain('pick a swatch');
    expect(el.querySelectorAll('.vanilla-log-line').length).toBe(2);
    expect(el.querySelector('.vanilla-log-line')!.textContent).toContain('5 swatches');
    expect(el.querySelectorAll('.vanilla-log-line')[1].textContent).toContain(
      'globalThis.document === doc: true',
    );

    // ── The vendored library: global-document + innerHTML + delegation ──
    // MiniWidget mounted unmodified inside the shim — its markup came from
    // an innerHTML template parsed worker-side, its buttons delegate clicks
    // through a `listen` op on the island container (id 0).
    const widget = el.querySelector('.mini-widget')!;
    expect(widget).not.toBeNull();
    expect(widget.querySelector('.mw-label')!.textContent).toContain('vendored lib');
    expect(widget.querySelectorAll('.mw-btn').length).toBe(2);
    expect(el.innerHTML).toContain('mw-bar'); // innerHTML markup serialized to real DOM

    // Delegated click on a widget button — bubbles to the container, where
    // the document-level `listen` op's real listener dispatches back; the
    // lib's `e.target.closest('[data-action]')` runs on the synthesized
    // payload.target.
    const ping = widget.querySelector('[data-action="ping"]')!;
    fire(ping, new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() =>
      expect(widget.querySelectorAll('.mw-entry').length).toBe(1),
    );
    expect(widget.querySelector('.mw-entry')!.textContent).toBe('ping #1');
    expect(widget.querySelector('.mw-entry')!.getAttribute('data-n')).toBe('1');

    // The lib's clear button exercises `log.innerHTML = ''` — replace children.
    const clear = widget.querySelector('[data-action="clear"]')!;
    fire(clear, new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(widget.querySelectorAll('.mw-entry').length).toBe(0));

    // Click swatch #2 — the listen op wired a real DOM listener; dispatch
    // routes the EventPayload into the worker handler, whose proxy-DOM
    // mutations stream back as ops.
    fire(swatches[1], new MouseEvent('click', { bubbles: true, clientX: 40, clientY: 17 }));
    await vi.waitFor(() => expect(readout.textContent).toContain('#1f9d55'));
    expect(readout.textContent).toContain('(40, 17)'); // coordinates round-tripped
    expect((readout as HTMLElement).style.color).not.toBe('');
    // classList.toggle('active') on every sibling → attr ops for 'class'
    expect(swatches[1].classList.contains('active')).toBe(true);
    expect(swatches[0].classList.contains('active')).toBe(false);
    // The handler's appendLog ran too — getElementById lookup succeeded.
    const lines = el.querySelectorAll('.vanilla-log-line');
    expect(lines.length).toBe(3);
    expect(lines[2].textContent).toContain('clicked #1f9d55');
    expect(lines[2].textContent).toContain('getElementById');

    // The emit carries the enriched payload fields back to the shell.
    await vi.waitFor(() => expect(emitted.some((e) => e.name === 'colorPicked')).toBe(true));
    const picked = emitted.find((e) => e.name === 'colorPicked')!.payload as {
      color: string;
      x: number;
      y: number;
      targetId?: number;
    };
    expect(picked.color).toBe('#1f9d55');
    expect(picked.x).toBe(40);
    expect(picked.y).toBe(17);
    // targetId resolves through the driver's node→id map — the swatch is an
    // op-created node, so its worker instance id crosses back.
    expect(picked.targetId).toBeGreaterThan(0);

    // updateProps on an imperative realm = clear + rebuild on a fresh doc —
    // the widget remounts too (fresh shim + fresh MiniWidget.mount).
    await island.updateProps({ title: 'rebuilt widget' });
    expect(el.querySelector('.vanilla-heading')!.textContent).toBe('rebuilt widget');
    expect(el.querySelectorAll('.swatch').length).toBe(5);
    expect(el.querySelector('.mini-widget')).not.toBeNull();

    island.destroy();
  });
});
