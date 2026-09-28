/**
 * Realm-scoped state shared by every renderer backend running inside a worker.
 *
 * - Per-realm op queues: each island/app owns a queue of {@link Op}s that the
 *   main-thread driver replays as real DOM mutations.
 * - A shared id counter for element/text instances, used by both the React
 *   reconciler and the proxy DOM.
 * - Handler registry for event listeners.
 * - Doorbell contract used to bump the ops-version after a commit.
 * - Pushed container-size geometry.
 *
 * This module is renderer-agnostic: it contains no react-reconciler imports.
 * The React-specific host config lives in `hostConfig.ts`.
 */

import { renderMemory } from '../memory';
import type { Op, WireProps } from '../ops';

/* ── Host instances ─────────────────────────────────────────────────────── */

export interface ElementInstance {
  kind: 'element';
  id: number;
  type: string;
  /** Which mounted app this node belongs to — routes its ops. */
  realm: string;
  /** Namespace URI for non-HTML elements (svg/mathml) — rides the `create`
   *  op so the driver uses `createElementNS`. Tracked via host context. */
  ns?: string;
  /** Last serialized prop set — needed so hide/unhide can resend it. */
  props: WireProps;
  /** propName → stable handler id (keeps DOM listeners stable across updates). */
  listenerSlots: Record<string, number>;
}

export interface TextInstance {
  kind: 'text';
  id: number;
  text: string;
  realm: string;
}

export type HostInstance = ElementInstance | TextInstance;

/** The root container is a sentinel — op `parent: 0` means "the root".
 *  defineIslandWorker stamps `realm` on the container it hands
 *  createContainer, so createInstance can bind every element to the realm
 *  that rendered it — deterministic even when a commit runs outside a realm
 *  task (passive-effect renders, scheduler flushes), where activeRealm is
 *  ''. Instance-bound ops then always reach their island's queue. */
export interface RootContainer {
  id: 0;
  realm?: string;
}
export const ROOT_CONTAINER = Object.freeze({ id: 0 }) as RootContainer;

/* ── Per-realm op queues + instance/handler tables ──────────────────────── */

/** realm (app name) → queued ops. Each island flushes only its own queue. */
const opsByRealm = new Map<string, Op[]>();
/** The realm a task is currently executing under — see setActiveRealm. */
let activeRealm = '';
/**
 * instance id → host record. Exported so the proxy DOM (worker/proxyDom.ts)
 * shares the SAME instance space as the reconciler: a proxy-created element
 * can nest inside a React-rendered parent and vice versa, because ops are
 * id-addressed and ids come from one counter.
 */
export const instances = new Map<number, HostInstance>();
interface HandlerEntry {
  fn: (payload: unknown) => void;
  realm: string;
  /** The element this handler was attached to — the event's currentTarget. */
  instanceId?: number;
}
/** handler id → prop function + owning realm. Lives worker-side; never serialized. */
const handlers = new Map<number, HandlerEntry>();
let nextId = 1;
let nextHandlerId = 1;

/** Allocate an instance id — the shared counter React and the proxy DOM both draw from. */
export const allocId = (): number => nextId++;

/**
 * Marks which realm the currently-running task belongs to; returns the
 * previous value for restore. Structural ops don't need it — they route by
 * their instance's realm — but instance-less ops (`clear`, `emit`) and
 * handler dispatch do. Worker tasks run synchronously, so a single pointer
 * is safe even when several realms coexist in one module.
 */
let lastRealm = '';
export const setActiveRealm = (realm: string): string => {
  const prev = activeRealm;
  activeRealm = realm;
  if (realm !== '') lastRealm = realm;
  return prev;
};

/** The realm the current task is running under — '' outside a realm task. */
export const getActiveRealm = (): string => activeRealm;

/**
 * The most recent realm a task ran under — used by the realm dispatcher to
 * route deferred library work (timers, promise continuations) to the right
 * document when several realms share one module (in-process tests).
 */
export const getLastActiveRealm = (): string => lastRealm;

/**
 * Marks `realm` as the ambient realm for out-of-task readers (timers,
 * continuations, shim consumers outside realm work). Called by
 * installDomShim so its document becomes the ambient document.
 */
export const markRealmActive = (realm: string): void => {
  if (realm) lastRealm = realm;
};

/**
 * Run `fn` while `realm` is the active realm — the imperative-code twin of
 * the reconciler's syncCommit wrapper. Imperative DOM writes (`emit`, the
 * proxy DOM's `emit` calls, `clear`) only route correctly while a realm
 * task holds the active realm: mount, updateProps, and dispatch all wrap
 * their work in this, and imperative apps should do the same for any
 * worker-initiated work (timers, promise continuations).
 */
export const runInRealm = <T>(realm: string, fn: () => T): T => {
  const prev = setActiveRealm(realm);
  try {
    return fn();
  } finally {
    setActiveRealm(prev);
  }
};

/** Queue an op onto a realm's queue — instance-bound ops pass their
 *  instance's realm, instance-less ops (`clear`, `emit`) the active one. */
export const pushOp = (realm: string, op: Op): void => {
  let queue = opsByRealm.get(realm);
  if (!queue) opsByRealm.set(realm, (queue = []));
  queue.push(op);
};

/** The minimum surface `bumpOpsVersion` needs off the doorbell contract. */
interface DoorbellContract {
  readonly bound: boolean;
  connector(path: string): { read(): unknown; write(v: unknown): void };
}

/**
 * The contract `bumpOpsVersion` writes to — `renderMemory` by default, or
 * whatever doorbell-shaped contract `defineIslandWorker({ sharedMemory })`
 * was handed. Overriding requires the SAME spec as the main-side
 * `makeDoorbell()` (the pool sizes the buffer for it), so this is a rarely
 * needed escape hatch, not a general field contract.
 */
let doorbell: DoorbellContract = renderMemory;

/** Point the doorbell writes at a different doorbell-spec contract. */
export const setDoorbellContract = (contract: DoorbellContract): void => {
  doorbell = contract;
};

/**
 * The doorbell write resetAfterCommit performs, exported so non-React op
 * producers (the proxy DOM) can ring it too — a commit made outside any
 * task still needs to wake the island's observe() loop. No-op while the
 * contract is unbound (before the pool's INIT_MEMORY handshake).
 */
export const bumpOpsVersion = (): void => {
  if (!doorbell.bound) return;
  const bell = doorbell.connector('opsVersion');
  bell.write(Number(bell.read() ?? 0) + 1);
};

/** Drain one realm's queued ops — called by the worker's task methods. */
export const takeOps = (realm: string): Op[] => {
  const queue = opsByRealm.get(realm);
  if (!queue || queue.length === 0) return [];
  opsByRealm.set(realm, []);
  return queue;
};

export const getHandler = (id: number): HandlerEntry | undefined => handlers.get(id);

/* ── Pushed container size (setSize channel) ────────────────────────────── */

/**
 * realm key → the island container's last measured {w,h}, pushed by the
 * driver's `setSize` task. This is the ONLY geometry channel: the main
 * thread can only measure the island's root box, so the proxy DOM serves
 * this value to `doc.body`/`documentElement` and to elements explicitly
 * marked `doc.markContainer(el)` — every other element keeps the honest 0.
 * Module-level (not per-document) so it survives imperative rebuilds that
 * swap in a fresh proxy document.
 */
const realmSizes = new Map<string, { w: number; h: number }>();

/** The realm's last pushed container size, or undefined if none arrived. */
export const getRealmSize = (realm: string): { w: number; h: number } | undefined =>
  realmSizes.get(realm);

/** Store the container size a `setSize` task pushed. */
export const setRealmSize = (realm: string, w: number, h: number): void => {
  realmSizes.set(realm, { w, h });
};

/**
 * Register a function in the handler table outside prop serialization —
 * the proxy DOM's addEventListener uses this. The realm is stamped on the
 * entry so a dispatched event routes its re-render ops to the right queue.
 * `listen`/`unlisten` ops carry the returned id so the main thread can wire
 * and later detach the matching DOM listener.
 */
export const registerHandler = (
  fn: (payload: unknown) => void,
  realm: string,
  instanceId?: number,
): number => {
  const id = nextHandlerId++;
  handlers.set(id, { fn, realm, instanceId });
  return id;
};

export const unregisterHandler = (id: number): void => {
  handlers.delete(id);
};

/**
 * The island→shell channel. Apps call `emit(name, payload)` inside event
 * handlers or commit-phase effects — it just queues an `emit` op, which the
 * main-thread driver routes to the island's `onEvent` callback instead of
 * the DOM. Call it while a task holds the realm (handlers, layout effects);
 * a bare emit from a passive effect has no realm to route to in the
 * many-realms-per-module case and would be dropped.
 */
export const emit = (name: string, payload?: unknown): void => {
  pushOp(activeRealm, { t: 'emit', name, payload });
};

/* ── Prop serialization ─────────────────────────────────────────────────── */

/**
 * Props must cross postMessage, so: `children` is skipped (structure comes
 * from append/remove ops), `key`/`ref` are skipped, functions named `on*`
 * become `{ __evt: id }`, everything else passes through structured clone.
 * Each (instance, propName) pair reuses one handler-id slot, so the id the
 * main thread sees never changes across re-renders — it can attach the DOM
 * listener exactly once while the handler id keeps pointing at the latest
 * closure.
 */
export function serializeProps(instance: ElementInstance, props: Record<string, unknown>): WireProps {
  const out: WireProps = {};
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (name === 'children' || name === 'key' || name === 'ref' || name === 'dangerouslySetInnerHTML') {
      continue;
    }
    if (typeof value === 'function') {
      if (name.length > 2 && name.startsWith('on')) {
        let slot = instance.listenerSlots[name];
        if (slot === undefined) {
          slot = nextHandlerId++;
          instance.listenerSlots[name] = slot;
        }
        handlers.set(slot, {
          fn: value as (payload: unknown) => void,
          realm: instance.realm,
          instanceId: instance.id,
        });
        out[name] = { __evt: slot };
      }
      // Non-event functions (render props, callbacks) can't cross the wire — dropped.
      continue;
    }
    out[name] = value; // style objects, numbers, strings, booleans all clone fine
  }
  return out;
}

/* ── Small factories ────────────────────────────────────────────────────── */

export function newElement(
  type: string,
  props: Record<string, unknown>,
  ns: string | undefined,
  realm: string,
): ElementInstance {
  const instance: ElementInstance = {
    kind: 'element',
    id: allocId(),
    type,
    ns,
    realm,
    props: {},
    listenerSlots: {},
  };
  instance.props = serializeProps(instance, props);
  instances.set(instance.id, instance);
  return instance;
}

export function newText(text: string, realm: string): TextInstance {
  const instance: TextInstance = { kind: 'text', id: allocId(), text, realm };
  instances.set(instance.id, instance);
  return instance;
}
