# @jwhenry123/mesh-worker-dom

Worker-side React reconciler + proxy-DOM islands for `@jwhenry123/mesh` — opt-in
DOM rendering inside workers. A real `react-reconciler@0.34` runs in the worker
against a DOM-free host config; every commit serializes to an op stream that the
main thread replays as DOM mutations. Imperative (non-React) apps get a proxy
`document` whose mutations emit the same ops — plus `installDomShim(doc)`, which
sets `globalThis.document`/`window` so real DOM-dependent libraries run
unmodified inside a realm.

## Quickstart

```ts
// render.worker.ts — the whole worker entry
import { defineIslandWorker } from '@jwhenry123/mesh-worker-dom/worker';

export const renderWorker = defineIslandWorker({
  apps: {
    dashboard: DashboardApp,                        // a React component
    vanilla: { imperative: (doc, props) => { ... } } // or pure proxy-DOM code
  },
});
```

```ts
// main thread
import { connectIslandWorker, mountIsland } from '@jwhenry123/mesh-worker-dom';

const island = await mountIsland({
  client: connectIslandWorker({
    worker: () => new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' }),
  }),
  el: document.getElementById('island')!,
  app: 'dashboard',
  props: { ... },
  onEvent: (name, payload) => { ... },        // island → shell emit() channel
  slots: { preview: (el) => mountCanvas(el) }, // transclusion holes
});
island.updateProps({ ... });
island.destroy();
```

## React shells: `@jwhenry123/mesh-react-island`

When the *shell* itself is a React app, the companion package
[`@jwhenry123/mesh-react-island`](../react-island) wraps these calls in
components — `<Island/>` for the declarative `mountIsland`, and the
`islandComponent`/`lazyIsland` proxies that make a worker app look and type
like a local component (Suspense on the module load, `fallback` prop on the
mount). This package stays React-free on the shell side by design — the
component layer lives there.

App contracts still live here: `islandApp(name, app)` stamps an app with its
registry name (a data property — minification-proof, unlike `fn.name`) so a
shell-side component reference resolves to the wire key, and
`defineIslandWorker` warns if a stamp and its registry key drift apart.
`IslandAppProps<A>` infers a reference's props type from its signature.

## Island rules

- **poolSize is pinned to 1.** One tree lives in one worker's memory —
  scale out with more islands (`connectIslandWorker` per island), not wider pools.
- **Two worker entries.** `defineIslandWorker({ apps })` is a registry —
  one script serves many named apps. `defineRealmWorker(app)` is the 1:1
  form — one script, one app, bundled with only that app's dependencies and
  mounted namelessly (`mountIsland({ client, el })`, no `app`). A
  single-registered-app worker resolves its sole app regardless of the
  requested name.
- **Realm keys** are `app` or `app@N`; `mountIsland` mints them, the same app
  can mount in many islands at once, and `mount`/`updateProps`/`dispatch`/
  `flush`/`unmount`/`whoami` all take the realm first.
- **Clients can be shared.** Several `mountIsland`s into ONE
  `connectIslandWorker` co-locate their realms in one worker (multi-island-
  per-worker). `destroy()` unmounts just that realm via `unmount`; the
  worker terminates when its last island leaves.
- **`emit(name, payload)`** is the island→shell channel — call inside handlers
  or commit-phase effects while a task holds the realm. From a library
  callback that fires on a timer or promise (no realm active), wrap it:
  `runInRealm(realm, () => { emit(...); bumpOpsVersion(); })` — Leaflet's
  `zoomend` in the demo does exactly this.
- **Slots** — `<Slot name="x"/>` renders a leaf `data-mesh-slot` element whose
  contents the shell fills with real main-thread DOM.
- **The proxy DOM is write-path-plus-container-geometry.** Shadow-tree reads
  work (children, querySelector, innerHTML); so does ONE measured box — the
  driver's `ResizeObserver` pushes the island container's size into the realm
  (`setSize`), and `doc.body`/`documentElement`/elements marked
  `doc.markContainer(el)` report it from `clientWidth`/`offsetWidth`/
  `getBoundingClientRect`. Everything else returns honest 0/empty and warns
  once. `doc.onResize(cb)` re-fires on each push (Leaflet uses it for
  `map.invalidateSize()`).
- **Event payloads are spec-shaped for pointer events.** clientX/Y, screenX/Y,
  button, `which` (button+1), modifiers, wheel deltaX/Y/deltaMode, pointerType,
  scrollTop, and `targetId` (resolved to a proxy node as `payload.target`) all
  cross. Pointer-family events always carry *numeric* coords — absent fields
  normalize to 0 rather than leaking `undefined` into library math. At dispatch
  time `target`/`currentTarget` materialize as proxy nodes (`currentTarget` =
  the node the handler was attached to, the realm root for id-0 listeners) so
  library middleware can read them — geometry still returns honest zeros.
- **`installDomShim(doc)`** puts the proxy doc on `globalThis.document` plus a
  `window` facade — `innerHTML` parses via htmlparser2, `document`/`window`
  listeners land on the island container (id 0) so delegation works,
  `window.innerWidth/innerHeight` reflect the pushed size, and
  `globalThis.Element` becomes `ProxyElement` for `instanceof` checks.
  `globalThis.addEventListener` and `self` are never touched — the pool's
  message channel lives there. `uninstall()` (or `doc.dispose()`) restores the
  globals.
- **Realm-aware globals.** `defineIslandWorker` installs a dispatcher so
  `document`/`window`/`Element` are *accessors*, not fixed globals: inside a
  realm task they resolve that realm's document (its facade, `ProxyElement`),
  outside tasks they resolve the sole or last-active realm's, and explicit
  assignments (`installDomShim`, test harnesses) take precedence over implicit
  resolution. React realms get a working `document`/`window` for free —
  libraries that read them during render or in deferred callbacks just work.
  On the main-thread driver, element checks are structural (`nodeType`), never
  `instanceof Element` — the same global may be a proxy in in-process setups.
- **SVG + portals + library refs.** Ops carry a namespace (`create` gets `ns`)
  and host context tracks `<svg>`/`<foreignObject>` boundaries — the driver
  uses `createElementNS`, so `<svg>` trees land correctly, including through
  portals (the container's namespace propagates). `getPublicInstance` exposes
  `ProxyElement` facades, which are valid react-dom `createPortal` containers —
  this is what makes recharts' tooltip/legend portals work unmodified.

## Real libraries — what works

**Imperative libraries.** The `map` island in `examples/react-dom-worker` runs
**Leaflet 1.9, unmodified from npm**, entirely worker-side: `installDomShim(doc)`
then `await import('leaflet')` (dynamic import is required — Leaflet reads
`document`/`window` at module scope for Browser detection). Verified working:
tile `<img>` ops, divIcon markers, controls, attribution, drag-pan
(document-level listeners registered mid-gesture), wheel zoom, delegated
marker clicks, and `doc.onResize` → `invalidateSize()`.

**React libraries.** The `charts` island runs **recharts 3.x, unmodified**, as
an ordinary React tree in the worker: `ComposedChart` with grid/axes/tooltip/
legend/bar/line, `onClick` handlers, and `emit` — verified end-to-end with a
bar-click round-trip. It exercises the general machinery above: namespaced
SVG ops, `ProxyElement` refs as portal targets (tooltip/legend render via
react-dom `createPortal`), realm-resolved `document`/`window` for its
selector/`getComputedStyle` calls, and `currentTarget` synthesis for its
mouse middleware. Use fixed chart dimensions — `ResponsiveContainer` has no
layout to observe — and prefer `isAnimationActive={false}` to skip
measurement-feedback render passes that converge but cost op volume.

Known limits for DOM-heavy libraries:

- **Geometry is one box.** Only the island container is measured (pushed);
  libraries that measure arbitrary elements still get 0 — SVG-specific reads
  (`getBBox`, `getTotalLength`, `getComputedTextLength`) too, which is why
  recharts text truncation/animation sizing degrades to stub values.
- **`preventDefault`/`stopPropagation` are no-ops** — the real event already
  dispatched on the main thread; the worker can't cancel it.
- **Async-library callbacks that mutate DOM or emit outside a task** must
  re-enter via `runInRealm(realm, fn)` — timers and promise continuations
  have no active realm.
- **`getContext('2d'/'webgl')` is out of scope** for the op protocol —
  canvas-based libraries belong on `OffscreenCanvas`, which is a different
  transport.

Peer deps `react`/`react-reconciler` are required even for imperative-only
consumers — the package *is* the React-rendering pattern; tree-shaking drops
the reconciler if you never call `defineIslandWorker` with React apps.
