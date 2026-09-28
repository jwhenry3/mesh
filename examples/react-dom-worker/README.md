# React Worker Islands — registry + realm workers, N React trees

A standalone proof that **React's render logic needs no DOM** — scaled out to
islands. The real `react-reconciler@0.34` (the same package react-dom is built
on) runs inside Web Workers with a custom `supportsMutation` host config whose
"host instances" are plain records in a `Map`. Every render-phase and
mutation-phase hook appends a serialized op to a queue; task methods return the
flushed batch, and the main thread's only job is to replay the ops as real DOM
mutations.

**The whole pattern lives in `@jwhenry123/mesh-worker-dom`** — this example is
the consumer: its worker entries are ~20-line `defineIslandWorker({ apps })` /
`defineRealmWorker(app)` calls, its shell calls `connectIslandWorker({ worker })`
+ `mountIsland()`, and its imperative island demos the worker-side proxy DOM
plus the global `document`/`window` shim.

**The shell + islands model — worker-hosted microfrontends, two worker
topologies.** The demo mixes them deliberately:

- **Registry worker** (`defineIslandWorker({ apps })`) — `render.worker.ts`
  serves the React apps (`controls` / `data-table` / `stats` / `charts`) by
  name. Islands each get a `connectWorker` client — one pool, **poolSize
  pinned to 1**, one worker. The React shell goes further: the two
  `data-table` islands share ONE client, so both realms live in a single
  worker — separate reconcilers, op queues, and pids in one OS thread —
  and `destroy()` unmounts a realm without killing its sibling's worker.
- **Realm workers** (`defineRealmWorker(app)`) — `map.worker.ts` and
  `vanilla.worker.ts` are the 1:1 form: one script, one app, mounted
  namelessly (a single-app worker resolves its sole app whatever name is
  asked). Their bundles carry only that app's dependencies — no recharts,
  no other React apps.

Registry entries are either React components — reconciled into the realm's
own root — or `{ imperative: (doc, props) => void }` — apps built on the
worker-side **proxy DOM** with no React usage (see below). There is **no
React on the main thread of `index.html`**: `src/island.ts` is a dumb op
applier plus an event sink per island. (If your shell *is* a React app,
`@jwhenry123/mesh-react-island` exports `<Island/>` — the same
mount/updateProps/destroy lifecycle as a component — see `react-shell.html`.)

**A microfrontend is not limited to one instance.** Realm keys are
`app@N` — minted per island — so `'data-table'` mounts twice with
independent props and content, whether into separate workers (the vanilla
shell) or the same one (the React shell's shared client). `unmount` on the
wire tears a realm down without touching its siblings.
`connectIslandWorker({ worker, ...options })` takes the worker factory (the
package can't know where your entry lives) while `poolSize`/`sharedMemory`
stay island-internal — `poolSize: 1` is pinned after the spread, so pooling
can't be re-enabled even through a cast; everything else (`concurrency`,
`taskTimeout`, `respawn`, `lazy`…) still passes through.

**Transclusion — main-thread DOM inside a worker tree.** A worker app can
render `<Slot name="x"/>` (a leaf `<div data-mesh-slot="x">`): the island
owns the element's *box* — its layout, styles, and position in the op
stream — while the shell owns its *contents*. When the create op lands, the
driver calls `mountIsland({ slots: { x: (el) => … } })` with the real
element; mount a canvas, a Monaco editor, an AG Grid, or even a
`createRoot()` of main-thread React inside it — real DOM, real events, zero
wire traffic. The demo's stats island hosts a live waveform canvas drawn
by `requestAnimationFrame` on the main thread. Removal works too: when the
worker drops the element (directly or inside a removed subtree), the slot
callback fires with `null` for teardown. This is the escape hatch for every
library in the "structurally can't run in a worker" bucket — it doesn't
port into the worker, it gets *transcluded* around it.

**Two shells, same islands.** The demo ships two entry pages to prove the
op protocol doesn't care what the shell is made of. `index.html` +
`src/main.ts` is framework-free: `mountIsland({ el, app, props })` calls
plus hand-wired `island.updateProps` mediation — its bundle is ~4 kB.
`react-shell.html` + `src/shell.tsx` is the same seven islands through
`<Island/>` (`@jwhenry123/mesh-react-island`): each `mountIsland` call
becomes a component, badges ride `onReady` → state, and the
controls→table mediation is literally `onEvent → setState →
<Island props={…}>` — the component's deduped `updateProps` replaces the
hand-wiring. All seven islands mount through **`lazyIsland` proxies**, so
the worker app types like a local component with props inline —
`<TableIsland filter={f} desc/>` — and every dynamic import is a code-split
boundary covered by `<Suspense>` (react-shell chunk ~230 kB; recharts,
leaflet, and the imperative apps fetch as separate lazy chunks only when
their island mounts). The `fallback` prop covers the worker-mount window —
mount can't suspend because suspended trees never commit and mounting
needs the container in the DOM.

For shells that want zero worker-module imports, `islandComponent<P>('name')`
builds the same proxy from a registry key + type-only props contract.
And plain `<Island app="vanilla"/>` string mounting stays supported.

**Worker-side proxy DOM — the "WorkerDOM" pattern.** Transclusion covers
libraries that must run on the main thread; `src/worker/proxyDom.ts` covers
the opposite: imperative/DOM-dependent code that should run *inside* the
worker. `createProxyDocument(realm)` builds a fake `document` whose nodes
wrap the same host-instance records the reconciler uses — one `instances`
map, one id counter — so `createElement`, `appendChild`, `setAttribute`,
`classList`, `dataset`, `el.style.x`, `addEventListener`, and
`textContent` all emit ordinary ops instead of touching real DOM. Each
node also maintains a local **shadow tree** (`childNodes`/`parentNode`/
`firstChild`/`nextSibling`/`children`/`textContent` reads, plus
`getElementById` and a simple `querySelector`), so imperative code can
read back what it wrote — the only DOM reads that CAN work over an async
op channel. Because ops are id-addressed, proxy-created elements can nest
inside React-rendered parents and vice versa; `doc.adopt(instance)` wraps
any shared instance record for imperative navigation.

The `vanilla` island proves a realm can be **pure imperative code** — no
reconciler, no JSX, no React import. `mount` runs `build(doc)` inside
`runInRealm` and drains the emitted ops; `updateProps` is documented as
*clear + rebuild on a fresh document*; `dispatch` runs the handler inside
the realm so `emit()` and mutations route to the island's queue.

**The global DOM shim — unmodified libraries in a realm.** `installDomShim(doc)`
puts the realm's proxy document on `globalThis.document` plus a `window`
facade object (navigator/location stubs, timers + rAF, `addEventListener`).
Real DOM-dependent libraries — which reach for globals, build markup with
`innerHTML` (parsed worker-side via htmlparser2), and delegate events on
`document.addEventListener` — then run *unmodified* inside the realm.
`document`/`window` listeners emit `listen` ops on the island's container
(id 0) so delegated handlers see bubbling events, and dispatched payloads
get `target` synthesized to the proxy node (`e.target.closest()` works).
`globalThis.addEventListener`/`self` are never touched — the pool's message
channel lives there. The demo: `src/vendor/miniwidget.js` is a plain-JS
vendored widget mounted inside the vanilla island alongside the
hand-written proxy-DOM code — that's all a real library needs.

**The `map` island — real Leaflet 1.9, unmodified, in a worker.** The
stress test for the whole shim: `src/worker/map.ts` installs the DOM shim,
dynamically imports Leaflet (required — it reads `document`/`window` at
module scope), and mounts `L.map(doc.body)`. Tile `<img>`s, divIcon
markers, zoom/attribution controls, a custom place-picker control,
drag-pan, and wheel zoom all work through the op stream — Leaflet's
`Draggable` registers document-level `mousemove`/`mouseup` listeners
mid-gesture via `listen` ops, `ScrollWheelZoom`'s debounce timer emits
`zoomChanged` from outside any task (wrapped in `runInRealm` +
`bumpOpsVersion`), and delegated marker clicks route through Leaflet's
`_targets` stamp table onto proxy-element expandos. What makes it possible
is the one geometry channel: the driver's `ResizeObserver` pushes the
island container's size (`setSize`), which `doc.body` reports to Leaflet's
container measurements; `doc.onResize` replays it as `invalidateSize()`.
The stylesheet is shell-side (`import 'leaflet/dist/leaflet.css'`), and
tiles are real `<img>` elements — see the note on COEP `credentialless` in
`vite.config.ts` for why cross-origin tiles load under isolation.

**The `charts` island — real recharts 3.x, unmodified, inside a React
island.** Where Leaflet stresses the imperative shim, recharts stresses the
*React* machinery: `src/worker/apps.tsx`'s `ChartsApp` renders an ordinary
`ComposedChart` (grid, axes, tooltip, legend, bar + line — `isAnimationActive`
off to skip measurement churn). It works because of four general renderer
capabilities, not recharts-specific hacks: **namespaced SVG** — host context
tracks `<svg>`/`<foreignObject>` boundaries and ops carry a namespace so the
driver calls `createElementNS` (portal children inherit their target's
namespace too); **refs return proxy facades** — `getPublicInstance` hands
libraries a `ProxyElement`, so recharts' tooltip/legend `createPortal` target
(the wrapper's ref) is a valid container the host methods unwrap back to its
instance; **realm-aware globals** — `document`/`window`/`Element` resolve per
realm (inside tasks the active realm's doc, otherwise the sole/last-active
realm's — and plain assignments still override for out-of-realm code), so
recharts' `getComputedStyle`, selector calls (`getElementsByClassName`/
`getElementsByTagName`), and portal bookkeeping run unmodified; and
**event-object semantics** — dispatched payloads get `target`/`currentTarget`
synthesized to the owning proxy node, which is what the chart's mouse
middleware reads geometry from (honest zeros). A bar click updates local
state and emits `chartClicked` — one dispatch round-trip, like every other
interaction. The limits are the ones you'd predict: chart dimensions are
**fixed props** (`ResponsiveContainer` can't observe real layout without a
measurement channel), and geometry-reading features (tooltip positioning)
settle on stub values — SVG `getBBox`/`getTotalLength`/`offsetWidth` warn
once and return 0.

Islands never talk to each other directly — the **shell mediates**:

```
controls island: emit('filterChanged') ─┐
                                        ├─ shell onEvent → table.updateProps({filter, desc})
controls island: emit('sortChanged') ───┘
table island: emit('rowsChanged') ─────→ shell onEvent → stats.updateProps({visible, total})
both data-table islands: emit('rowSelected') → shell status line
controls island: emit('countChanged') ─→ shell status line
vanilla island: emit('colorPicked') ───→ shell status line
map island: emit('markerClicked' / 'placeSelected' / 'zoomChanged') → shell status line
charts island: emit('chartClicked') ─────────────────────────────────────────→ shell status line
```

Each island's header shows its `whoami()` pid — a random per-realm id proving
every island is a distinct worker (in the in-process test, a distinct render
realm).

## Files

Package code (`packages/worker-dom/` + `packages/react-island/`) does the
heavy lifting: `defineIslandWorker` (realms, reconcilers, op queues),
`hostConfig`, `proxyDom` + `installDomShim`, `mountIsland`/
`connectIslandWorker` + the op protocol + doorbell contract, and the
`<Island/>`/`lazyIsland`/`islandComponent` component layer. The example
keeps:

- `src/worker/render.worker.ts` — ~20 lines: `defineIslandWorker({ apps })` mapping island app names to components/imperative builders
- `src/worker/apps.tsx` — the four React island apps: `ControlsApp` (emits filter/sort/counter events), `TableApp` (2000-row memoized table, props-driven, emits rowSelected/rowsChanged), `StatsApp` (row count + busy-loop compute), `ChartsApp` (real recharts 3.x `ComposedChart`, fixed dims, emits `chartClicked` on bar click)
- `src/worker/vanilla.ts` — the imperative island app: a hand-written swatch picker + log on the proxy DOM, AND the vendored MiniWidget running on `installDomShim`'s globals (no React import)
- `src/worker/map.ts` — the map island app: `installDomShim` + dynamic `import('leaflet')`, then unmodified Leaflet 1.9 (`L.map`, tile layer, divIcon markers, a `L.Control.extend` place picker) on the proxy DOM
- `src/vendor/miniwidget.js` (+ `.d.ts`) — a plain-JS "third-party" widget: global `document`, `innerHTML` template, delegated `document.addEventListener` — mounted unmodified inside the island
- `src/main.ts` — the thin framework-free shell: layout, one `connectIslandWorker({ worker })` + `mountIsland()` per island, event mediation, global transport toggle, `import 'leaflet/dist/leaflet.css'`
- `src/shell.tsx` + `react-shell.html` — the React shell: the same seven islands mounted through `<Island/>` plus the `islandComponent`/`lazyIsland` proxies (inline worker-app props, Suspense for the module load, code-split recharts), state-driven mediation
- `test/islands.test.ts` — in-process E2E (InProcessWorker + happy-dom): distinct pids, emit → updateProps mediation, doorbell flush, remount semantics, same-app multi-instance, vendored-widget delegation
- `test/map.test.ts` — in-process E2E for the Leaflet island: tiles, markers, controls, delegated marker/place clicks, drag-pan, wheel zoom, `zoomChanged`/`markerClicked`/`placeSelected` emits
- `test/charts.test.ts` — in-process E2E for the recharts island: main surface + descendants carry the SVG namespace (zIndex portals included), grid/axis/bar markup lands, bar click emits `chartClicked` with the datum
- `test/shell.test.tsx` — in-process E2E for the React shell: `<Shell/>` mounts all seven islands via `<Island/>`, badges/stats aggregate in React-rendered DOM, controls→table mediation flows through state → `props`

## Protocol

Worker → main, batches of:

| op | shape | meaning |
| --- | --- | --- |
| `create` | `{id, type, props}` | `document.createElement(type)` + props (`{__evt:id}` → listener) |
| `text` | `{id, text}` | `document.createTextNode(text)` |
| `append` | `{parent, child, before?}` | `parent.insertBefore(child, before ?? null)`; parent `0` = island root |
| `remove` | `{child}` | detach the node |
| `update` | `{id, props}` | full re-serialized prop set; main diffs vs. its last set |
| `utext` | `{id, text}` | `node.textContent = text` (also proxy `element.textContent` writes) |
| `attr` | `{id, name, value\|null}` | proxy DOM attributes — set/removeAttribute with setProp's property heuristics; `null` removes |
| `style` | `{id, props}` | proxy DOM inline-style deltas — merge into `el.style`, `''` clears a key |
| `listen` | `{id, type, handler}` | proxy `addEventListener` — driver wires `handler` → `client.dispatch` |
| `unlisten` | `{id, type, handler}` | detach the listener a `listen` op attached |
| `clear` | `{}` | clear the island's root container (React remounts and imperative rebuilds) |
| `emit` | `{name, payload}` | **not** a DOM op — invokes the island's `onEvent(name, payload)` |

Main → worker (a realm key rides the wire for routing — `mountIsland` binds
it, so the shell sees `island.updateProps(props)`):

- `mount(realm, props)` → first op batch after a synchronous `updateContainer`
  commit. The realm key is `app` or `app@instance`: the part before the last
  `@` names the registry app, the rest distinguishes instances — which is how
  the same microfrontend can live in multiple islands (mountIsland mints a
  fresh `app@N` per island). Mounting an already-mounted realm key is a
  **remount**: the old tree unmounts (`clear` + detached instances), a fresh
  container renders — the batch replays onto an emptied root; the pid survives.
- `updateProps(realm, props)` → re-render the island's root with new
  serializable props — the shell→island channel.
- `dispatch(handlerId, payload)` → invokes the handler behind an `__evt`
  ref or a `listen` op (proxy `addEventListener` registers in the same
  handler table); returns the re-render's ops — one postMessage round-trip
  per interaction. The payload is `EventPayload` — pointer-family events
  carry normalized numeric coords/deltas/buttons (see the events caveat);
  `targetId` maps the event target to its worker instance id when it's an
  op-created node (shell-owned slot content has none).
- `setSize(realm, w, h)` → pushes the island container's measured box into
  the realm — the ONLY geometry channel. The driver calls it once at mount
  and on container resizes (throttled); imperative realms additionally fire
  their `doc.onResize` handlers and return their ops in the batch.
- `flush(realm)` → drains that realm's ops committed outside a task call
  (passive effects, timers).
- `whoami(realm)` → the realm's random pid.

## Notes & caveats

- **Pooling is disabled for islands — by construction, not just by
  convention.** `connectIslandWorker` omits `poolSize` from its options type
  and pins it to 1 internally. The reason is structural: one reconciled tree
  lives in one worker's memory, and a second worker in the pool would
  receive `dispatch`/`updateProps` calls for a tree it doesn't hold (its
  handler ids and instance ids belong to a different realm). A real pool
  can't serve islands anyway — task routing is least-busy round-robin —
  until the SDK grows sticky routing / per-worker task affinity (documented
  future work). **Scaling out means more islands, not wider pools**: each
  `mountIsland` call is a new worker, and the same microfrontend can be
  mounted as many times as you like — the page shows `data-table` twice with
  different props to prove it.
- **Ops are isolated per island.** Instance ids are only unique within one
  worker, so each island keeps its own nodes/props/listeners maps — sharing
  them would corrupt. On the worker side the same rule applies to ops: each
  instance records the realm key it was created under (`app@N`), and ops
  route to that realm's queue (multi-realm module state exists for the
  in-process test, where one module instance plays every worker — and is
  also what makes same-app multi-instance testable).
- **Slots are transclusion holes.** `data-mesh-slot` marks a leaf element:
  the driver calls `slots[name](el)` when it appears and `slots[name](null)`
  when the worker tree removes it — including when it's inside a subtree cut
  by a single `remove` op (the driver finds nested slots via the DOM
  attribute). Keep slot elements leaf-only on the worker side, and note
  there's no measurement channel: the island lays out the box but can't read
  the pixel size of what the shell put inside it — feed that back via
  `dispatch`/`updateProps` if a worker app needs it.
- **`emit` is the island→shell channel.** Island code calls `emit(name,
  payload)` inside event handlers or commit-phase effects (the demo uses
  `useLayoutEffect` for `rowsChanged`). Payloads are structured-cloned like
  props. Don't emit from a passive effect — outside a task there's no realm
  to route the op to.
- **The proxy DOM is write-path plus ONE measured box.** Its reads are
  served by a local shadow tree that only tracks proxy-side mutations, and
  geometry is limited to the pushed container size: the driver's
  `ResizeObserver` calls `setSize(realm, w, h)` (once at mount, then
  throttled on resize), and `doc.body`/`documentElement`/`markContainer`ed
  elements report it via `clientWidth`/`offsetWidth`/`getBoundingClientRect`.
  That single box is what lets Leaflet size its pane tree. Everything else —
  arbitrary-element `getBoundingClientRect`, `scrollTop/scrollHeight`,
  `getComputedStyle` — returns 0/empty and warns once per document
  (Partytown-style synchronous reads via `Atomics` blocking calls are
  possible future work — deliberately not faked). Imperative writes follow
  the same realm rule as `emit`: they must happen inside
  `runInRealm(realm, fn)` — mount/dispatch provide it automatically;
  worker-initiated work (timers, promise continuations, library callbacks
  like Leaflet's `zoomend`) must wrap itself and ring the doorbell
  (`bumpOpsVersion()`), since ops still queue correctly but nothing drains
  them until a task or flush runs — and `emit` outside a realm drops the op.
- **Imperative realms rebuild, not diff.** `updateProps` on an imperative
  realm emits `clear` and re-runs `build(props)` on a fresh proxy document
  (the old document is disposed — its handler ids unregister and mutating
  it throws). That's the honest semantics for code with no reconciler:
  correct for widgets, not for huge trees.
- **One doorbell contract instance per island.** A `SharedMemory` contract
  binds to exactly one buffer; each island's pool creates its own buffer, so
  the shell passes a fresh `makeDoorbell()` per client. The worker script has
  one module-level `renderMemory` — each worker instance binds its own copy.
- **Async updates need `flush()`.** `useEffect` state updates, timers, and
  promise continuations commit on the worker's own scheduler task; their ops
  sit in the realm queue until asked for. `resetAfterCommit` bumps
  `opsVersion`, the island's `observe()` wakes on `Atomics.waitAsync`, and
  `flush(app)` drains — the toolbar's **push/poll** toggle applies to every
  island and is called after all mounts (see `setMode` in island.ts).
- **Every interaction is a round-trip.** A keystroke = postMessage → worker
  re-render → ops back → DOM writes. Cross-island effects add one more hop:
  emit op → shell → `updateProps` task → second worker re-render → ops back.
- **No real DOM in worker code — but library DOM glue works.** React
  components get no real `document`/`window`/`useLayoutEffect` reads (using
  it only for `emit` timing is fine — it runs during commit, not render).
  Imperative code gets the *proxy* DOM instead — same-looking API,
  op-emitting mutations, shadow-tree reads, no layout. And the globals ARE
  defined now: `defineIslandWorker` installs a realm-aware dispatcher so
  `document`/`window`/`Element` resolve to the executing realm's proxy doc
  (plain assignments still win out-of-realm — `installDomShim` composes on
  top). Refs point at `ProxyElement` facades (valid `createPortal`
  containers — recharts uses them), geometry reads still honest-zero.
- **Events are plain payloads**, not SyntheticEvents:
  `{ type, value, checked, key, clientX/Y, screenX/Y, button, which,
  modifiers, deltaX/Y, deltaMode, pointerType, scrollTop, targetId }`.
  Pointer-family events (mouse/pointer/wheel/drag/click…) always carry
  *numeric* coordinates — the driver normalizes absent fields to 0 so
  worker-side event math (`e.clientX - rect.left`) never sees `undefined`;
  non-pointer events leave them `undefined`. `preventDefault`/
  `stopPropagation` on the payload are synthesized no-ops — the real event
  already dispatched; the worker can't cancel it. During dispatch the
  handler also gets `target`/`currentTarget` materialized as proxy nodes
  (`currentTarget` = the element the listener was registered on, the realm
  root for document-level listeners) — library code reading geometry off
  them gets honest zeros instead of `undefined` crashes. React-prop handlers are
  stable across re-renders — each (instance, prop) pair owns one `__evt`
  slot, so the main thread attaches each listener once. Proxy
  `addEventListener` uses the same handler table via `listen`/`unlisten`
  ops keyed by (type, handler id).
- **React DevTools can't see the worker trees** — each island's reconciler is
  a separate copy of React in another realm, and fiber internals don't cross
  postMessage.

## Run

```sh
npm install
npm run dev   # http://localhost:5177 (framework-free shell)
              # http://localhost:5177/react-shell.html (React + <Island/>)
npm run build # tsc --noEmit && vite build → emits a worker chunk
```
