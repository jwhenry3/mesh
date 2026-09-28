/**
 * Minimal island worker entry for the `<Island/>` component tests — one
 * imperative app: a paragraph echoing props.text and a button that emits.
 * The app def is `islandApp`-stamped so the shell mounts it by reference:
 * `<Island app={echoApp}/>` — the same object the registry holds.
 */
import {
  defineIslandWorker,
  emit,
  islandApp,
  type ProxyDocument,
} from '@jwhenry123/mesh-worker-dom/worker';

export const echoApp = islandApp('echo', {
  imperative: (doc: ProxyDocument, props: Record<string, unknown>): void => {
    const p = doc.createElement('p');
    p.className = 'echo';
    p.textContent = String(props.text ?? 'echo');
    const btn = doc.createElement('button');
    btn.className = 'ping';
    btn.textContent = 'ping';
    btn.addEventListener('click', () => emit('pinged', { n: 1 }));
    const slot = doc.createElement('div');
    slot.dataset.meshSlot = 'slot';
    doc.body.append(p, btn, slot);
  },
});

export const echoWorker = defineIslandWorker({
  apps: { echo: echoApp },
});
