// @vitest-environment happy-dom
/**
 * React-shell E2E — <Shell/> mounts all seven islands through <Island/>
 * components instead of imperative mountIsland() calls. Proves:
 *   - the shell mounts via the component API against the REAL worker entry,
 *   - the charts island resolves its name from the stamped component ref,
 *   - mediation works declaratively: a controls emit becomes a state change
 *     that flows back in as props (filter → table rows), and
 *   - badges/status/stats land in ordinary React-rendered DOM.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
vi.mock('react-dom/client', async () => {
  const mod = (await requireFromRoot())('react-dom/client') as Record<string, unknown>;
  return { ...mod, default: mod };
});

vi.stubGlobal('Worker', InProcessWorker);
// The shell mounts the registry worker AND the two realm workers — all
// entries register into the shared in-process module graph.
InProcessWorker.handlerModules = [
  () => import('../src/worker/render.worker'),
  () => import('../src/worker/vanilla.worker'),
  () => import('../src/worker/map.worker'),
];

const waitFor = async (fn: () => unknown, timeoutMs = 15_000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    try {
      const r = fn();
      if (r) return;
    } catch {
      /* keep polling */
    }
    if (Date.now() - start > timeoutMs) {
      fn();
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('React shell', () => {
  // In-process only: once a worker island calls installDomShim, the ambient
  // `document` getter can resolve to a worker realm's PROXY document — the
  // realm dispatcher and this test share globalThis. Capture the real one
  // before rendering; real browsers never share globals across threads.
  let realDoc: Document;

  beforeAll(async () => {
    realDoc = document;
    const { createRoot } = await import('react-dom/client');
    const { Shell } = await import('../src/shell');
    const host = realDoc.createElement('div');
    realDoc.body.appendChild(host);
    createRoot(host).render(<Shell />);
  });

  it('mounts every island through <Island/> components', async () => {
    await waitFor(() => realDoc.querySelectorAll('.island-root').length === 7);
    await waitFor(() => realDoc.querySelectorAll('.island-head .badge').length === 7);
    await waitFor(() =>
      [...realDoc.querySelectorAll('.island-head .badge')].every((b) =>
        /^worker w-/.test(b.textContent ?? ''),
      ),
    );
    // Real DOM landed via op replay inside the component-rendered divs.
    await waitFor(() => realDoc.querySelector('#island-table tbody tr'), 60_000);
    await waitFor(() => realDoc.querySelector('.vanilla-log'), 60_000);
    await waitFor(() => realDoc.querySelector('.recharts-surface'), 60_000);
  }, 120_000);

  it('mediates controls → table declaratively via props', async () => {
    const status = realDoc.getElementById('status-line')!;
    const rowsBefore = realDoc.querySelectorAll('#island-table tbody tr').length;
    expect(rowsBefore).toBeGreaterThan(0);

    // Type into the controls island's filter input — the emit becomes shell
    // state, which flows back as the table island's props.
    const input = realDoc.querySelector('.island-root input') as HTMLInputElement;
    input.value = 'eu-central';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    await waitFor(() => /filterChanged/.test(status.textContent ?? ''));
    await waitFor(() => {
      const cells = realDoc.querySelectorAll('#island-table tbody tr td:first-child');
      return cells.length > 0 && cells.length < rowsBefore;
    });
  }, 45_000);

  it('transport stats aggregate in React-rendered DOM', async () => {
    const stats = realDoc.getElementById('transport-stats')!;
    await waitFor(() => /ops applied: [1-9]/.test(stats.textContent ?? ''));
    expect(stats.textContent).toContain('sync: push');
  });

  afterAll(() => {
    InProcessWorker.handlerModules = [];
  });
});
