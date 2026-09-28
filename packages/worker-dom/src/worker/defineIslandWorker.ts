/**
 * Two entry points, two topologies:
 *
 *   // render.worker.ts — a REGISTRY worker: one script, many apps
 *   import { defineIslandWorker } from '@jwhenry123/mesh-worker-dom/worker';
 *   export const renderWorker = defineIslandWorker({
 *     apps: { controls: ControlsApp, table: TableApp },
 *   });
 *
 *   // charts.worker.ts — a REALM worker: one script, one app (1:1)
 *   export const chartsWorker = defineRealmWorker(ChartsApp);
 *
 * `defineIslandWorker` serves a registry — every island's worker runs the
 * same script and `mount(realm, props)` picks a component out of `apps`.
 * `defineRealmWorker` serves exactly one app: the shell mounts it without
 * naming a registry key (or with any name — a single-registered-app worker
 * resolves its sole app regardless), and the worker's bundle carries only
 * that app's dependencies.
 *
 * APP REGISTRY is module-level: in a real worker each entry file loads its
 * own module graph (a realm worker sees exactly its app); under the
 * in-process test harness several worker entries share one graph, so
 * registration is a UNION and mounts still resolve — same semantics both
 * worlds.
 *
 * REALM KEYS are `app` or `app@instance` — the part before the last '@'
 * names the registry app (or 'main' for unnamed realm-worker mounts), the
 * rest distinguishes instances so the same app can mount more than once —
 * INCLUDING into one shared worker when two islands share a client
 * (multi-island-per-worker: one worker, two realms, two reconcilers).
 * MountIsland mints a fresh key per island. Wire signatures carry the realm key (`updateProps(realm,
 * props)`, `flush(realm)`, `whoami(realm)`) so a call routes to its realm —
 * the main-thread mountIsland helper binds it, so shell code just calls
 * `island.updateProps(props)`.
 *
 * IMPERATIVE REALMS: a registry entry can be `{ imperative: (doc, props) }`
 * instead of a component. Those realms hold no reconciler at all: mount
 * hands the app a realm-scoped proxy DOM and its mutations emit ops
 * directly (updateProps = clear + rebuild, dispatch = runInRealm + drain,
 * flush = drain only). See worker/proxyDom.ts.
 *
 * Ops still ride back through the pool's ordinary postMessage channel — the
 * sharedMemory contract here is only the doorbell (see memory.ts): a commit
 * counter the main thread observe()s to trigger flush() as a push. Drop it
 * entirely and the islands still work on the 50ms poll — that's the
 * message-only mode.
 */

import { createElement, type ReactElement } from 'react';
import Reconciler from 'react-reconciler';
import { defineWorker } from '@jwhenry123/mesh/sdk';
import type { SharedMemory, WorkerDefinition } from '@jwhenry123/mesh/sdk';
import { islandAppNameOf } from '../app';
import { renderMemory, type DoorbellSpec } from '../memory';
import {
  createProxyDocument,
  installRealmDispatcher,
  realmDocFor,
  type InternalDocument,
  type ProxyDocument,
} from './proxyDom';
import { hostConfig } from './hostConfig';
import {
  getHandler,
  instances,
  pushOp,
  ROOT_CONTAINER,
  runInRealm,
  setActiveRealm,
  setDoorbellContract,
  setRealmSize,
  takeOps,
} from './realm';
import type { EventPayload, IslandWorkerMethods, Op } from '../ops';

/**
 * Registry value shapes:
 *  - a React component function — reconciled into the realm's own root.
 *    (`props: any` so plain `function App({ x }: Props)` components register
 *    without casts — props are serialized across the wire anyway.)
 *  - `{ imperative: (doc, props) => void }` — NO React at all. mount() hands
 *    it a proxy DOM scoped to the realm; its mutations emit ops directly.
 */
export type ReactIslandApp = (props: any) => ReactElement;
export interface ImperativeIslandApp {
  imperative: (doc: ProxyDocument, props: Record<string, unknown>) => void;
  /**
   * Optional teardown — runs inside the realm's scope BEFORE its proxy
   * document is disposed (unmount, remount, updateProps rebuild). Cancel
   * library timers/animation loops/listeners here (e.g. `map.remove()`) so
   * deferred work can't mutate a dead realm or a foreign ambient document
   * after teardown.
   */
  dispose?: (doc: ProxyDocument) => void;
}
/** The apps an island can mount — keyed by the name the shell passes to mount(). */
export type IslandApp = ReactIslandApp | ImperativeIslandApp;

export interface DefineIslandWorkerRegistry {
  /** Name → app registry. The shell's `mountIsland({ app: name })` picks one. */
  apps: Record<string, IslandApp>;
  /**
   * The doorbell contract the worker exposes — defaults to the package's
   * `renderMemory`. Rarely needed: pass a different doorbell-SPEC instance
   * if your worker module already defines one (the main side always uses
   * `makeDoorbell()`, so the spec must match: `opsVersion` number field).
   */
  sharedMemory?: SharedMemory<DoorbellSpec>;
}

/** Either a registry of apps or a single app for a 1:1 realm worker. */
export type DefineIslandWorkerInput = IslandApp | DefineIslandWorkerRegistry;
/** @deprecated Use DefineIslandWorkerRegistry instead. */
export type DefineIslandWorkerOptions = DefineIslandWorkerRegistry;

const isImperative = (app: IslandApp | undefined): app is ImperativeIslandApp =>
  typeof app === 'object' && app !== null && 'imperative' in app;

interface RealmBase {
  /** The wire key — 'app' or 'app@instance'; op queues route by this. */
  key: string;
  /** The registry name — which component this realm renders. */
  app: string;
  /** Per-realm random id — shown in the island's badge as proof it's a
   *  distinct render realm (in production: a distinct worker). Stable across
   *  remounts of the same realm key. */
  pid: string;
}

interface ReactRealm extends RealmBase {
  imperative?: undefined;
  reconciler: ReturnType<typeof Reconciler>;
  container: unknown;
}

interface ImperativeRealm extends RealmBase {
  imperative: {
    build: ImperativeIslandApp['imperative'];
    /** Optional app teardown — run before the realm's doc is disposed. */
    dispose: ImperativeIslandApp['dispose'];
    /** The realm's proxy document — replaced on each rebuild. */
    doc: ProxyDocument;
    props: Record<string, unknown>;
  };
}

/** A mounted realm — one per island worker in production. */
export type Realm = ReactRealm | ImperativeRealm;

const isImperativeRealm = (r: Realm): r is ImperativeRealm => r.imperative !== undefined;

/** realm key → mounted realm. Production workers hold one entry per island
 *  mounted into them — more than one only when islands share a client. */
const realms = new Map<string, Realm>();

/**
 * Module-level app registry — one module graph = one registry (see the
 * header note). defineIslandWorker registers its whole `apps` map;
 * defineRealmWorker registers its single app.
 */
const APP_REGISTRY = new Map<string, IslandApp>();

const isRegistry = (input: DefineIslandWorkerInput): input is DefineIslandWorkerRegistry =>
  typeof input === 'object' && input !== null && 'apps' in input;

const registerSingleApp = (name: string, app: IslandApp): void => {
  APP_REGISTRY.set(name, app);
};

/**
 * Resolve a mount's registry name → app. A single-entry registry is
 * name-blind: a realm worker mounts its one app whatever realm key arrives
 * ('main@1' from an un-named <Island/>, 'charts@2' from a stamped one), so
 * `app` is genuinely optional on the shell side for 1:1 workers.
 */
const resolveApp = (name: string): IslandApp | undefined =>
  APP_REGISTRY.get(name) ??
  (APP_REGISTRY.size === 1 ? APP_REGISTRY.values().next().value : undefined);

const newPid = (): string => `w-${Math.random().toString(36).slice(2, 8)}`;

/** 'controls' or 'data-table@7' → 'data-table' — registry name part of a realm key. */
const appNameOf = (realm: string): string => {
  const at = realm.lastIndexOf('@');
  return at === -1 ? realm : realm.slice(0, at);
};

/**
 * The worker-side half of an island — registers mount / updateProps /
 * dispatch / flush / whoami on the worker's task surface and wires the
 * doorbell contract. Shared by both entry points; they differ only in what
 * they register.
 */
function createIslandRuntime(
  sharedMemory: SharedMemory<DoorbellSpec> = renderMemory,
): WorkerDefinition<DoorbellSpec, IslandWorkerMethods> {
  // Point bumpOpsVersion at the declared contract (it's the same object as
  // renderMemory unless a custom doorbell instance was passed).
  setDoorbellContract(sharedMemory);
  // Give every realm DOM globals — `document`/`window`/`Element` resolve to
  // the active realm's proxy document. Libraries a React app pulls in
  // (recharts, d3-ish helpers) can then read them without the app ever
  // installing a shim; imperative apps get the same globals via
  // installDomShim, which builds on this.
  installRealmDispatcher();

  // Legacy root (tag 0) — no concurrent features. Container creation is
  // per-realm, not module-level, so a second mount() can't collide with the
  // first realm's tree. Imperative realms skip the reconciler entirely —
  // their "host environment" is the proxy DOM, and build() emits ops itself.
  function createRealm(key: string, pid: string): Realm {
    const app = resolveApp(appNameOf(key));
    if (isImperative(app)) {
      return {
        key,
        app: appNameOf(key),
        pid,
        imperative: {
          build: app.imperative,
          dispose: app.dispose,
          doc: createProxyDocument(key),
          props: {},
        },
      };
    }
    const reconciler = Reconciler(hostConfig);
    const container = reconciler.createContainer(
      // Realm-stamped root container — createInstance reads `.realm` off it,
      // binding every element to this realm even in out-of-task commits.
      { id: 0, realm: key } as typeof ROOT_CONTAINER,
      0,
      null,
      false,
      null,
      '',
      console.error, // onUncaughtError
      console.error, // onCaughtError
      console.error, // onRecoverableError
      null, // onDefaultTransitionIndicator
    );
    return { key, app: appNameOf(key), pid, reconciler, container };
  }

  /**
   * Commit synchronously around `fn` and return the ops it produced, scoped
   * to `realm`'s queue.
   *
   * In 0.34, `updateContainer`/setState only *schedule* work — the actual
   * render+commit happens when the root scheduler task runs (a macrotask via
   * the `scheduler` package). `flushSyncFromReconciler` pins the update
   * priority to the discrete/sync lane for the duration of `fn` and flushes
   * pending sync work in its `finally`, so by the time it returns the
   * mutation hooks have run and the realm's op queue is full.
   */
  function syncCommit(realm: ReactRealm, fn: () => void): Op[] {
    const prev = setActiveRealm(realm.key);
    try {
      realm.reconciler.flushSyncFromReconciler(fn);
      realm.reconciler.flushSyncWork();
      return takeOps(realm.key);
    } finally {
      setActiveRealm(prev);
    }
  }

  /**
   * Rebuild an imperative realm — the simplest honest updateProps/remount
   * semantics for code with no reconciler: dispose the old document (its
   * handler ids die with it — and the global DOM shim it installed is
   * unwound), emit `clear` so the driver empties the island root, then
   * re-run build() on a FRESH proxy document whose shadow tree starts
   * empty like the real one. All inside the realm's active scope so emit()
   * and instance-less ops route correctly.
   */
  function rebuildImperative(realm: ImperativeRealm, props: Record<string, unknown>): Op[] {
    return runInRealm(realm.key, () => {
      const imp = realm.imperative;
      imp.dispose?.(imp.doc);
      imp.doc.dispose();
      pushOp(realm.key, { t: 'clear' });
      imp.doc = createProxyDocument(realm.key);
      imp.props = props;
      imp.build(imp.doc, props);
      return takeOps(realm.key);
    });
  }

  return defineWorker({
    sharedMemory,
    methods: {
      /**
       * Mount apps[appNameOf(realm)] into its own root; returns the
       * initial op batch. The realm key may carry an instance suffix
       * ('data-table@3') so the same app can mount multiple times.
       *
       * Mounting a realm key that is already mounted is a REMOUNT: the old
       * tree is unmounted first (a `clear` op + GC of its instance records),
       * then a fresh container renders the new tree — the returned batch
       * replays cleanly onto an emptied root. The pid is kept across remounts.
       */
      mount(realm: string, props: Record<string, unknown> = {}): Op[] {
        const App = resolveApp(appNameOf(realm));
        if (App === undefined) {
          throw new Error(
            `mount: unknown app "${realm}" — registry has: ${[...APP_REGISTRY.keys()].join(', ')}`,
          );
        }

        let mounted = realms.get(realm);
        // Imperative remount — same clear+rebuild semantics as updateProps;
        // the realm (and pid) survives.
        if (mounted !== undefined && isImperativeRealm(mounted)) {
          return rebuildImperative(mounted, props);
        }

        let ops: Op[] = [];
        if (mounted !== undefined) {
          // Remount — unmount the existing tree so React detaches its
          // instances, then rebuild on a fresh container.
          const old = mounted;
          ops = syncCommit(old, () => {
            old.reconciler.updateContainer(null, old.container, null, null);
          });
          mounted = createRealm(realm, old.pid);
        } else {
          mounted = createRealm(realm, newPid());
        }
        realms.set(realm, mounted);

        if (isImperativeRealm(mounted)) {
          // First mount of an imperative realm — run build() in the realm's
          // scope and drain the ops its proxy-DOM mutations emitted.
          const imp = mounted.imperative;
          imp.props = props;
          return ops.concat(
            runInRealm(realm, () => {
              imp.build(imp.doc, props);
              return takeOps(realm);
            }),
          );
        }

        const reactRealm = mounted as ReactRealm;
        return ops.concat(
          syncCommit(reactRealm, () => {
            reactRealm.reconciler.updateContainer(
              createElement(App as (props: Record<string, unknown>) => ReactElement, props),
              reactRealm.container,
              null,
              null,
            );
          }),
        );
      },

      /**
       * Re-render the realm's root with new props — the shell→island channel.
       * `updateProps` is how the shell mediates between islands (controls
       * emits filterChanged → shell → table.updateProps({filter})).
       */
      updateProps(realm: string, props: Record<string, unknown>): Op[] {
        const mounted = realms.get(realm);
        if (mounted === undefined) {
          throw new Error(`updateProps: "${realm}" is not mounted in this worker — mount() first`);
        }
        // Imperative realms have no diffing — updateProps REBUILDS: clear the
        // root and re-run build(props) on a fresh proxy document. Documented
        // as the honest semantics; fine for widgets, not for huge trees.
        if (isImperativeRealm(mounted)) return rebuildImperative(mounted, props);
        const App = resolveApp(mounted.app) as (props: Record<string, unknown>) => ReactElement;
        return syncCommit(mounted, () => {
          mounted.reconciler.updateContainer(createElement(App, props), mounted.container, null, null);
        });
      },

      /**
       * Run the prop function the main thread identified by handlerId —
       * `__evt` refs are handles into the worker's handler table. The entry
       * records which realm registered it, so the re-render's ops land on the
       * right island's queue.
       */
      dispatch(handlerId: number, payload: EventPayload): Op[] {
        const entry = getHandler(handlerId);
        if (entry === undefined) return [];
        const realm = realms.get(entry.realm);
        if (realm === undefined) return []; // stale handler — its tree was remounted
        // Give handlers real event-object semantics: `target` is the proxy
        // node for the wire's targetId (when it maps to an op-created node),
        // `currentTarget` the element this handler was attached to. Libraries
        // that read geometry off them (recharts' getRelativeCoordinate) get
        // the proxy's honest zeros instead of crashing on undefined.
        const p = payload as EventPayload & { target?: unknown; currentTarget?: unknown };
        if (p.target === undefined || p.currentTarget === undefined) {
          const doc = realmDocFor(realm.key);
          if (p.target === undefined && typeof p.targetId === 'number') {
            const t = instances.get(p.targetId);
            if (t !== undefined) p.target = doc.adopt(t);
          }
          if (p.currentTarget === undefined && entry.instanceId !== undefined) {
            // id 0 = the island container — its facade is the doc's root.
            p.currentTarget =
              entry.instanceId === 0
                ? doc._root
                : (instances.get(entry.instanceId) !== undefined
                    ? doc.adopt(instances.get(entry.instanceId)!)
                    : undefined);
          }
        }
        if (isImperativeRealm(realm)) {
          // No reconciler to flush — the handler's proxy-DOM mutations emit
          // ops directly; runInRealm gives emit() and instance-less ops a
          // queue to route to.
          return runInRealm(realm.key, () => {
            entry.fn(payload);
            return takeOps(realm.key);
          });
        }
        return syncCommit(realm, () => {
          entry.fn(payload);
        });
      },

      /**
       * The pushed-size channel: the driver measured the island's container
       * and stores it for the realm (see hostConfig realmSizes). Imperative
       * realms additionally fire their proxy document's onResize handlers —
       * inside the realm's scope so their mutations emit ops, which ride
       * back in this task's return batch. React realms have no proxy doc;
       * the stored size is still what a shim-installed document would read.
       */
      setSize(realm: string, width: number, height: number): Op[] {
        setRealmSize(realm, width, height);
        const mounted = realms.get(realm);
        if (mounted !== undefined && isImperativeRealm(mounted)) {
          return runInRealm(mounted.key, () => {
            (mounted.imperative.doc as InternalDocument)._notifySize(width, height);
            return takeOps(realm);
          });
        }
        return takeOps(realm);
      },

      /**
       * Tear down ONE realm while the worker keeps serving its others —
       * the multi-island-per-worker counterpart to process death: unmounts
       * the React tree (or disposes the imperative realm's proxy document),
       * drops the realm entry, and returns the detach op batch. Stale
       * handler dispatches then no-op via the realms.get() guard.
       */
      unmount(realm: string): Op[] {
        const mounted = realms.get(realm);
        if (mounted === undefined) return [];
        realms.delete(realm);
        if (isImperativeRealm(mounted)) {
          // The app's dispose hook cancels deferred work (library timers,
          // animation loops) BEFORE the doc dies — disposing the doc then
          // unwinds its DOM shim and drops its handlers.
          runInRealm(realm, () => {
            const imp = mounted.imperative;
            imp.dispose?.(imp.doc);
            imp.doc.dispose();
          });
          return [{ t: 'clear' }];
        }
        return syncCommit(mounted, () => {
          mounted.reconciler.updateContainer(null, mounted.container, null, null);
        });
      },

      /**
       * Drain one realm's ops committed outside a sync task — passive effects
       * (useEffect), timers, async setState. The pool protocol has no push
       * channel, so the main thread polls this (or the doorbell pushes it).
       */
      flush(realm: string): Op[] {
        const mounted = realms.get(realm);
        if (mounted === undefined) return [];
        // Imperative realms have no passive effects — ops committed outside a
        // task (timers, continuations mutating the proxy DOM) just drain.
        if (isImperativeRealm(mounted)) return takeOps(realm);
        const prev = setActiveRealm(realm);
        try {
          mounted.reconciler.flushPassiveEffects();
          mounted.reconciler.flushSyncWork();
          return takeOps(realm);
        } finally {
          setActiveRealm(prev);
        }
      },

      /** The mounted realm's random id — the island's "worker pid" badge. */
      whoami(realm: string): string {
        return realms.get(realm)?.pid ?? 'unmounted';
      },
    },
  });
}

/**
 * Define a worker that serves one or more apps. Pass a single app for a
 * 1:1 realm worker, or an `{ apps }` registry for a multi-app worker.
 * The shell can mount a registry worker by name; a single-app worker
 * resolves its sole app regardless of the supplied name, so `app` is
 * optional on <Island/> for 1:1 topologies.
 */
export function defineIslandWorker(
  input: DefineIslandWorkerInput,
  options?: { sharedMemory?: SharedMemory<DoorbellSpec> },
): WorkerDefinition<DoorbellSpec, IslandWorkerMethods> {
  if (isRegistry(input)) {
    for (const [key, app] of Object.entries(input.apps)) {
      const stamped = islandAppNameOf(app);
      if (stamped !== undefined && stamped !== key) {
        console.warn(
          `[defineIslandWorker] app registered as "${key}" but stamped "${stamped}" — ` +
            `component-reference mounts resolve "${stamped}" and will fail. Fix the key or the stamp.`,
        );
      }
      registerSingleApp(key, app);
    }
    return createIslandRuntime(input.sharedMemory ?? options?.sharedMemory);
  }
  const stamp = (input as { islandAppName?: unknown }).islandAppName;
  registerSingleApp(typeof stamp === 'string' && stamp !== '' ? stamp : 'main', input);
  return createIslandRuntime(options?.sharedMemory);
}

/**
 * Realm worker — one worker script serving ONE app (1:1). This is now a thin
 * alias for `defineIslandWorker(app)`; kept for backwards compatibility.
 */
export function defineRealmWorker(
  app: IslandApp,
  options?: { sharedMemory?: SharedMemory<DoorbellSpec> },
): WorkerDefinition<DoorbellSpec, IslandWorkerMethods> {
  return defineIslandWorker(app, options);
}
