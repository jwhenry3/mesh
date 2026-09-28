# Changelog

## Unreleased

- **New package: `@jwhenry123/mesh-react-island`** — the React shell
  components split out of `@jwhenry123/mesh-worker-dom` (which stays
  React-free on the main thread): `<Island/>` mounts a worker app
  declaratively, `islandComponent<P>('name')` proxies a worker app as a
  local-typed component without importing it, and `lazyIsland(loader)`
  mirrors `React.lazy` — suspends on the dynamic import (a real code-split
  boundary) then mounts the `islandApp`-stamped reference.
- **New package: `@jwhenry123/mesh-worker-dom`** — the React-in-worker
  islands pattern extracted from the react-dom-worker example into an
  opt-in package. `defineIslandWorker({ apps })` is the whole worker entry
  (React realms via a real `react-reconciler@0.34`, or `{ imperative }`
  realms on the worker-side proxy DOM); `connectIslandWorker({ worker })`
  + `mountIsland()` are the main-thread driver — no React on the main
  thread, just op replay.
- **Global DOM shim + innerHTML in the proxy DOM.** `installDomShim(doc)`
  sets `globalThis.document` and a `window` facade (never touching
  `globalThis.addEventListener`/`self` — the pool's channel lives there), so
  real DOM-dependent libraries run unmodified inside a realm: `innerHTML`
  parses via htmlparser2, `document`/`window.addEventListener` emit `listen`
  ops on the island container (id 0) for delegation, and dispatched
  `EventPayload`s gain a synthesized `target` proxy node. Also new on proxy
  elements: `outerHTML`, `insertAdjacentHTML/Element`, `cloneNode`,
  `append`/`prepend`/`replaceChildren`/`remove`, `closest`/`matches`,
  `getRootNode`, `ownerDocument`; `document.addEventListener` and text-node
  `data`/`nodeValue` accessors.
- The react-dom-worker example now consumes the package (a `file:` dep +
  source aliases) and demos the shim with a vendored plain-JS widget.

## 0.1.1 — packaging

No API changes — this release fixes what ships and how it ships.

- **Published tarball 139 kB → 60 kB.** `*.test.ts` sources and dist
  sourcemaps no longer ship (the `src/sdk` TypeScript sources still do, via
  the `./sdk/*` export).
- **Core `dist` is now per-module, not a 230 kB monolith.** Dependencies
  (`zod`, `msgpackr`, `@msgpack/msgpack`, `solid-js`) are external instead of
  inlined, so importing only `WorkerPool`/`connectWorker` no longer pulls
  `mz`/zod into your bundle — consumer bundlers tree-shake the parts you
  don't use.
- `fast-json-stringify` moved to `devDependencies` — it was a
  benchmark-only dependency being installed by consumers.
- `workerBootstrap` is marked as the package's one side-effectful module so
  bundlers don't drop its `self.onmessage` wiring when pruning.
- `mesh-node` and `mesh-nestjs` now ship READMEs.
- Release pipeline: CI **stages** packages with `npm stage publish` —
  versions stay non-installable until maintainer 2FA approval — and supports
  OIDC trusted publishing (`npm trust github … --allow-stage-publish`) so the
  workflow can be run secretless and stage-only.

## 0.1.0 — initial release

Typed shared-memory worker pools for TypeScript. The worker file is the
contract: `defineWorker` declares the method surface once, `connectWorker`
gives the main thread a typed, lazy client — and a shared-memory contract can
flow live values into UI state without a single `postMessage` copy.

### Core SDK — `@jwhenry123/mesh`

**Worker authoring & clients**

- `defineWorker({ sharedMemory?, methods })` — self-bootstrapping worker entry;
  methods are plain functions or `serviceMethod` units with zod wire schemas.
  Nested `services: { name: { ... } }` namespaces methods as `name.method`.
- `connectWorker<typeof worker>({ worker, sharedMemory?, poolSize, … })` —
  typed client proxy over a `WorkerPool`; **lazy spawn** makes it SSR-safe —
  the pool starts on the first call (or `client.start()`), never on import.
- `workerClient(runner)` — wraps any `TaskRunner` you already own in the same
  typed surface. Method proxies are cached, so `client.method` is a stable
  reference safe for `useMemo`/effect deps.

**Pool scheduling & lifecycle**

- Least-busy dispatch, per-worker `concurrency`, FIFO queue with `maxQueue`
  backpressure (`PoolQueueFullError`).
- Per-call cancellation and timeouts: `client.with({ signal, timeout })`.
  In-flight aborts reject the caller immediately (`TaskAbortedError`) while
  the worker's slot stays occupied until its late reply arrives — no
  double-booking.
- Worker crash → in-flight calls reject (`WorkerCrashedError`), worker
  respawns (`respawn: false` shrinks the pool instead). `taskTimeout` default
  with per-call override (`TaskTimeoutError`).
- `pool.stats()` — worker/queue/in-flight counts plus wait & run aggregates;
  `pool.close()` drains then terminates; `terminate()` is immediate.

**Shared memory — opt-in, not required**

- `defineSharedMemory({ field.number(), field.string({ schema }), … })` — one
  declaration is simultaneously the binary layout, the zod validator, and the
  TypeScript type. `mz` schemas (`mz.u32()`, `mz.int(min,max)`,
  `mz.string(bytes)`, `mz.object`, `mz.array`) pick the narrowest fixed-width
  storage; `field.list` lays out fixed-size record arrays (`readAt`/`writeAt`/
  `commit`); `maxBytes` stays as the codec escape hatch for dynamic values.
- Versioned fields: every write bumps an atomic version counter; `observe()`
  parks on `Atomics.waitAsync` (poll fallback) — workers write in place and
  the UI updates with zero message copies.
- Omit `sharedMemory` entirely and the pool is a typed, pooled, cancellable
  worker RPC — bare `INIT` handshake, no `SharedArrayBuffer`, **no COOP/COEP
  headers required**.
- Codecs `jsonCodec`/`msgpackCodec`/`msgpackrCodec`; pluggable storage via
  `registerConnectorFactory` and per-contract `plugins`; `MemoryManager` for
  manual buffer allocation.

**Explicit service layer** (what `defineWorker`/`connectWorker` build on)

- `defineService` / `implementService` / `createClient` / `serviceMethod` /
  `rpc<A, R>` — contract objects both threads can hold at runtime; wire ids
  derive as `service.method`; signatures infer from schemas.

**SharedWorker** — `connectSharedWorker` + `sharedWorkerHost`: one worker (and
one buffer) shared across tabs/iframes.

### Framework bindings — independently published

| Package | API |
|---|---|
| `@jwhenry123/mesh-react` | `useObservable`, `useSharedValue`, `useTask` |
| `@jwhenry123/mesh-vue` | `useObservable`, `useSharedValue`, `useTask` |
| `@jwhenry123/mesh-solidjs` | `createObservable`, `createSharedValue`, `createTask` |
| `@jwhenry123/mesh-svelte` | `observableValue`, `sharedValue`, `taskState` (runes) |
| `@jwhenry123/mesh-angular` | `observableSignal`, `sharedValue`, `taskState` (signals), `provideMesh`, `injectMeshPool` |
| `@jwhenry123/mesh-nextjs` | React hooks re-exported for App Router client components |

Every task binding accepts an `AsyncTask` **or a plain async function** — a
client method like `useTask(incidents.queryIncidents)` binds directly, with
per-call-site task state (no module-global latest-wins clobbering).

**Angular** also ships `MeshModule` — the Nest vocabulary for NgModule apps:
`forRoot`/`forRootAsync` at the root, `registerPool`/`registerPoolAsync`
inside the feature module that owns the worker, `@InjectMeshPool` for
ctor-param injection. Pools terminate on injector destroy (teardown/HMR).

### Server side

- `@jwhenry123/mesh-node` — `createNodePool` (auto-adapts
  `node:worker_threads.Worker`), `createNodeWorker`, the `/shim` worker entry
  (`self = parentPort`). No isolation headers needed on Node.
- `@jwhenry123/mesh-nestjs` — `MeshModule.forRoot/forRootAsync` +
  `registerPool/registerPoolAsync` (feature-module-owned pools, Bull-style);
  `@MeshService({ pool })` class-level and `@MeshTask` method-level offload —
  bodies run inside the worker's own Nest context on DI-resolved providers;
  `runMeshWorker(AppModule)` is the entire worker entrypoint; worker-side
  guard prevents nested pools when feature modules are shared between
  API and worker contexts.

### Requirements & caveats

- Browser `Worker` (or `node:worker_threads`); `SharedArrayBuffer` +
  `crossOriginIsolated` only when `sharedMemory` is used.
- Safari lacks `SharedWorker` — feature-detect before `connectSharedWorker`.
- Bindings ship TypeScript source; your bundler compiles them. Works with
  TypeScript 6 and 7.
- Single-writer field semantics — multi-writer coordination is on you
  (`Atomics.compareExchange` or a designated writer).

### Ecosystem in the box

- Docs: `jwhenry3.github.io/mesh/` — `/sdk/` internals site, `/consumer/`
  usage site (quickstart, per-framework pages, isolation/hosting guides).
- Runnable examples for all six frameworks + NestJS + Node, an `incidents`
  domain package as the reference integration, and a `benchmark` example.
- 43 test files / 348 tests including a real `nest build` → boot → HTTP e2e.
- Releases stage to npm (`npm stage publish`) for maintainer-approved,
  provenance-attested publishing.
