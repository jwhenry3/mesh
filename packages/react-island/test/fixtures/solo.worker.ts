/**
 * A realm-worker fixture — `defineRealmWorker` registers ONE app (unstamped
 * → under 'main'), so shells mount it namelessly: `<Island worker/>`
 * and `islandComponent<P>()` both resolve 'main'. Distinct from the echo
 * fixture so a same-worker second island gets its own realm.
 */
import { defineRealmWorker, emit, type ProxyDocument } from '@jwhenry123/mesh-worker-dom/worker';

export let disposed = false;

export const soloWorker = defineRealmWorker({
  imperative: (doc: ProxyDocument, props: Record<string, unknown>): void => {
    const p = doc.createElement('p');
    p.className = 'solo';
    p.textContent = String(props.label ?? 'solo realm');
    const btn = doc.createElement('button');
    btn.className = 'ping';
    btn.textContent = 'ping';
    btn.addEventListener('click', () => emit('pinged', { realm: 'solo' }));
    doc.body.append(p, btn);
  },
  dispose() {
    disposed = true;
  },
});
