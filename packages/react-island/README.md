# @jwhenry123/mesh-react-island

The React shell surface for `@jwhenry123/mesh-worker-dom` — mount a
worker-hosted React (or imperative proxy-DOM) tree as an ordinary element
in a main-thread React app. The worker's render loop produces a serialized
op stream; this package's components own the mount lifecycle and replay it
onto a real `div`.

```bash
npm install @jwhenry123/mesh @jwhenry123/mesh-worker-dom @jwhenry123/mesh-react-island react
```

## `<Island/>`

```tsx
import { Island } from '@jwhenry123/mesh-react-island';
import { ChartsApp } from './worker/apps';

const renderWorker = () =>
  new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' });

<Island
  worker={renderWorker}          // or client={connectIslandWorker({...})}
  app={ChartsApp}                // or the registry name 'charts'
  props={{ width: 520 }}         // inferred from ChartsApp's own props
  onEvent={(name, payload) => ...}
  slots={{ preview: (el) => (el ? mountCanvas(el) : teardown()) }}
  onReady={(island) => console.log(island.pid)}
  className="island-box"
/>
```

**Mount by reference, not by string.** `app` accepts the registry key or the
app itself — stamp it once with `islandApp` and both sides share one handle:

```ts
// worker/apps.tsx — the stamp is a data property, minification-proof
export const ChartsApp = islandApp('charts', function ChartsApp(props: ChartsProps) { ... });
export const mapApp = islandApp('map', { imperative: buildMap });
// worker entry: apps: { charts: ChartsApp, map: mapApp }   (defineIslandWorker
// warns if a stamp and its registry key drift apart)
```

`IslandAppProps` infers `props` from the reference's signature — a React
component's own props or an imperative def's props parameter — so
`props={{missing: 1}}` fails to compile. Bare (unstamped) components fall
back to `displayName`/function name for the wire key — dev convenience;
bundlers mangle `fn.name`, which is what the stamp exists for.

The rendered `div` is the island's container — `className`/`style`/`data-*`
spread onto it. Mounting is async (worker spawn + first op batch in an
effect, cancellation-safe); `props` changes call `updateProps`, deduped by
serialized identity so equal props don't cost a round-trip. `onEvent`/
`slots`/`onActivity` are read through refs — fresh closures never remount.
`app` remounts on change; `worker`/`client` are mount-stable (use `key` to
swap). Unmount destroys the island and terminates its worker. All the
[worker-dom island rules](../worker-dom/README.md#island-rules) apply
unchanged.

`examples/react-dom-worker/react-shell.html` mounts all seven demo islands
this way — worth a look for the mediation pattern (`onEvent → setState →
<Island props>` replaces hand-wired `updateProps`).

## Worker-loaded component proxies

`islandComponent` and `lazyIsland` go one step further: they return a
component that takes the **worker app's props inline** — the island looks
and types like a local component. Every prop that isn't a shell concern
(`worker`/`client`/`onEvent`/`onReady`/`onError`/`onActivity`/`slots`/
`fallback`/`containerProps`) forwards as the island's props.

```tsx
import { islandComponent, lazyIsland } from '@jwhenry123/mesh-react-island';
import type { TableProps } from './worker/apps'; // type-only: erased, zero bundle cost

// The pure-contract proxy — the shell NEVER imports the implementation.
// Registry key + props type IS the contract; the worker owns the code.
const TableIsland = islandComponent<TableProps>('data-table');
<TableIsland worker={renderWorker} filter={filter} desc onEvent={…} />

// The React.lazy mirror — suspends while the module loads, then mounts by
// stamped component reference. The dynamic import is a real split point:
// the worker component's deps only load when the island mounts.
const ChartsIsland = lazyIsland(() =>
  import('./worker/apps').then((m) => ({ default: m.ChartsApp })),
);
<Suspense fallback="loading…">
  <ChartsIsland worker={renderWorker} width={520} />
</Suspense>
```

One asymmetry vs `React.lazy`, by construction: the *loader* suspends but
the *mount* can't — suspended trees never commit, and mounting needs the
container div in the DOM. The mount window is covered by the `fallback`
prop instead of Suspense. `lazyIsland` also fixes the bundle caveat from
`<Island app={Comp}>`: a static import pulls the worker component's deps
(recharts in the demo: +~500 kB) into the shell chunk eagerly; the lazy
path splits them out, and `islandComponent` never imports them at all.

`islandComponent` overloads: `islandComponent<P>('name')` for the
type-contract form above, or `islandComponent(StampedApp)` to infer `P`
from a stamped reference the shell already has.

## Worker topologies — registry, realm, shared client

Two worker entry points, mixable in one app:

```ts
// render.worker.ts — REGISTRY worker: one script, many named apps
export const renderWorker = defineIslandWorker({ apps: { charts: ChartsApp, table: TableApp } });

// map.worker.ts — REALM worker: one script, ONE app (1:1)
export const mapWorker = defineRealmWorker(mapApp);
```

A realm worker's app resolves regardless of the requested registry name, so
the shell mounts it **namelessly** — `<Island worker={mapWorker}/>` or
`islandComponent<P>()` with no key — and its bundle carries only that app's
dependencies. `lazyIsland` accepts the worker module itself as the contract:
`lazyIsland(() => import('./worker/map.worker'))` resolves `{ app, worker }`
so the island carries its own worker.

For multi-island-per-worker, share a client: `client={connectIslandWorker({ worker })}`
mounts each island's realm into the SAME worker (separate reconcilers, op
queues, and pids — one OS thread). `destroy()` on one island unmounts just
its realm; the worker dies with the last island to leave.
