import { parseDocument, ElementType } from 'htmlparser2';
import {
  allocId,
  bumpOpsVersion,
  getActiveRealm,
  getLastActiveRealm,
  getRealmSize,
  instances,
  markRealmActive,
  pushOp,
  registerHandler,
  unregisterHandler,
} from '../realm';
import type { ElementInstance, HostInstance, TextInstance } from '../realm';
import type { EventPayload, Op } from '../../ops';

import {
  activeRealmDoc,
  ambientDoc,
  createProxyDocument,
  realmDocFor,
  type InternalDocument,
  type ProxyDocument,
} from './document';
import { ProxyElement } from './element';
import type { ProxyEventHandler } from './node';

/* ── The global shim ───────────────────────────────────────────────────── */

/** What installDomShim puts on globalThis.window — a facade OBJECT, not
 *  globalThis itself (the pool's message channel lives on self). */
export interface WindowShim {
  document: ProxyDocument;
  navigator: { userAgent: string };
  location: { href: string; reload(): void; assign(url: string): void; replace(url: string): void };
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  requestAnimationFrame(cb: (time: number) => void): number;
  cancelAnimationFrame(id?: number): void;
  setTimeout(
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ): number;
  clearTimeout(id?: number): void;
  setInterval(
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ): number;
  clearInterval(id?: number): void;
  getComputedStyle(el: unknown): Record<string, never>;
  /** Media queries can't be answered worker-side — always `matches: false`. */
  matchMedia(query: string): MediaQueryList;
  addEventListener(type: string, fn: ProxyEventHandler): void;
  removeEventListener(type: string, fn: ProxyEventHandler): void;
  /** Scrolling is main-thread business — no-ops so window.scrollTo(x,y)
   *  calls in libraries don't throw. */
  scrollTo(x?: number | ScrollToOptions, y?: number): void;
  scrollBy(x?: number | ScrollToOptions, y?: number): void;
  scroll(x?: number | ScrollToOptions, y?: number): void;
}

/**
 * The uninstall currently returned by the latest installDomShim — chained
 * so installing a fresh document's shim first unwinds the previous one.
 */
let activeShimUninstall: (() => void) | null = null;

export interface WindowFacadeBundle {
  facade: WindowShim;
  /** Detach every surviving window listener — ops and handler-table entries. */
  teardown(): void;
}

/**
 * Build the `window` facade for one realm's document — shared by
 * installDomShim (imperative apps) and the realm dispatcher (React realms
 * get a window the first time library code reads one). The bundle caches
 * on the document so both paths hand out the SAME facade — a listener
 * registered through `window` must land in the same table whichever global
 * routed the call.
 */
const buildWindowFacade = (internal: InternalDocument): WindowFacadeBundle => {
  const g = globalThis as Record<string, unknown>;

  /** type → fn → handler id. Window listeners get their own table (a lib
   *  removing a document listener must not detach its window twin), but
   *  land on the same id-0 container as document listeners. */
  const windowListeners = new Map<string, Map<ProxyEventHandler, number>>();

  const pushDocOp = (op: Op): void => {
    pushOp(internal.realm, op);
    if (getActiveRealm() !== internal.realm) bumpOpsVersion();
  };

  const windowAddEventListener = (type: string, fn: ProxyEventHandler): void => {
    internal._assertAlive();
    let table = windowListeners.get(type);
    if (table === undefined) windowListeners.set(type, (table = new Map()));
    if (table.has(fn)) return; // real DOM dedupes identical pairs
    const hid = registerHandler(
      (p) => fn(internal._enrichEvent(p as EventPayload)),
      internal.realm,
      0, // window-level listener → currentTarget is the island root
    );
    table.set(fn, hid);
    internal._handlerIds.add(hid);
    pushDocOp({ t: 'listen', id: 0, type, handler: hid });
  };

  const windowRemoveEventListener = (type: string, fn: ProxyEventHandler): void => {
    internal._assertAlive();
    const table = windowListeners.get(type);
    const hid = table?.get(fn);
    if (hid === undefined) return;
    table!.delete(fn);
    unregisterHandler(hid);
    internal._handlerIds.delete(hid);
    pushDocOp({ t: 'unlisten', id: 0, type, handler: hid });
  };

  const raf = g.requestAnimationFrame as ((cb: (time: number) => void) => number) | undefined;
  const caf = g.cancelAnimationFrame as ((id: number) => void) | undefined;
  const globalSetTimeout = g.setTimeout as typeof setTimeout;
  const globalSetInterval = g.setInterval as typeof setInterval;
  const globalClearTimeout = g.clearTimeout as typeof clearTimeout;
  const globalClearInterval = g.clearInterval as typeof clearInterval;

  // A realm owns the timers/rAFs it schedules through this facade; teardown
  // cancels them so deferred library work (Leaflet drag inertia, scroll-zoom
  // debounces, etc.) doesn't outlive the document and mutate a dead or
  // foreign ambient DOM. We wrap callbacks so completed ones drop their id.
  const timeouts = new Set<number>();
  const intervals = new Set<number>();
  const rafs = new Set<number>();

  const facade: WindowShim = {
    document: internal,
    navigator: { userAgent: 'mesh-worker-dom' },
    location: {
      href: 'about:blank',
      reload() {},
      assign(_url: string) {},
      replace(_url: string) {},
    },
    get innerWidth(): number {
      // Fed by the pushed container size — the viewport the island lives in.
      return getRealmSize(internal.realm)?.w ?? 0;
    },
    get innerHeight(): number {
      return getRealmSize(internal.realm)?.h ?? 0;
    },
    devicePixelRatio: 1,
    // Workers normally have no rAF — pass through when one exists (in-process
    // test), degrade to a 16ms timer otherwise. Schedule through the host
    // timers but keep track of the handles so teardown can cancel pending
    // callbacks (Leaflet's drag/zoom animations, etc.).
    requestAnimationFrame(cb: (time: number) => void): number {
      let id: number;
      const wrapped = (time: number): void => {
        rafs.delete(id);
        cb(time);
      };
      id = typeof raf === 'function'
        ? raf.call(globalThis, wrapped)
        : (globalSetTimeout((stamp: number) => wrapped(stamp), 16, Date.now()) as unknown as number);
      rafs.add(id);
      return id;
    },
    cancelAnimationFrame(id?: number): void {
      if (id === undefined) return;
      rafs.delete(id);
      if (typeof caf === 'function') caf.call(globalThis, id);
      else globalClearTimeout(id);
    },
    setTimeout(...args: Parameters<typeof setTimeout>): number {
      const [cb, delay, ...rest] = args as [
        cb: (...a: unknown[]) => void,
        delay?: number,
        ...rest: unknown[],
      ];
      let id: number;
      const wrapped = (...a: unknown[]): void => {
        timeouts.delete(id);
        cb(...a);
      };
      id = globalSetTimeout(wrapped, delay, ...rest) as unknown as number;
      timeouts.add(id);
      return id;
    },
    clearTimeout(id?: number): void {
      if (id === undefined) return;
      timeouts.delete(id);
      globalClearTimeout(id);
    },
    setInterval(...args: Parameters<typeof setInterval>): number {
      const [cb, delay, ...rest] = args as [
        cb: (...a: unknown[]) => void,
        delay?: number,
        ...rest: unknown[],
      ];
      const id = globalSetInterval(cb, delay, ...rest) as unknown as number;
      intervals.add(id);
      return id;
    },
    clearInterval(id?: number): void {
      if (id === undefined) return;
      intervals.delete(id);
      globalClearInterval(id);
    },
    // No measurement channel — an empty declaration, same honesty rule as
    // doc.getComputedStyle (which warns once); the facade stays silent.
    getComputedStyle: () => ({}),
    // No preference/quiz surface exists worker-side — media queries never
    // match. The shape is complete enough for feature-detection code.
    matchMedia: (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
    addEventListener: windowAddEventListener,
    removeEventListener: windowRemoveEventListener,
    // No scroll surface exists worker-side — libraries call these during
    // gesture handlers (Leaflet's Keyboard._onMouseDown scrolls the page
    // back); honest no-ops.
    scrollTo: () => {},
    scrollBy: () => {},
    scroll: () => {},
  };

  const teardown = (): void => {
    for (const id of rafs) {
      if (typeof caf === 'function') caf.call(globalThis, id);
      else globalClearTimeout(id);
    }
    rafs.clear();
    for (const id of timeouts) globalClearTimeout(id);
    timeouts.clear();
    for (const id of intervals) globalClearInterval(id);
    intervals.clear();
    for (const [type, table] of windowListeners) {
      for (const hid of table.values()) {
        unregisterHandler(hid);
        internal._handlerIds.delete(hid);
        if (!internal._disposed) pushOp(internal.realm, { t: 'unlisten', id: 0, type, handler: hid });
      }
      table.clear();
    }
  };

  return { facade, teardown };
};

/** The document's window facade, built once and shared by every path. */
const windowFacadeFor = (internal: InternalDocument): WindowFacadeBundle => {
  if (internal._windowBundle === undefined) {
    internal._windowBundle = buildWindowFacade(internal);
  }
  return internal._windowBundle;
};

let realmDispatcherInstalled = false;

/**
 * Define `document`/`window`/`Element` as GLOBAL GETTERS that resolve to
 * the current realm's proxy document — the mechanism that lets React-island
 * libraries (recharts reading `window.getComputedStyle`, `document.body`)
 * work without their app ever touching a doc, and that routes imperative
 * library calls correctly when several realms share one module (the
 * in-process test layout).
 *
 * Resolution (docForCurrentContext): the active realm's doc inside tasks;
 * the single registered doc when only one realm exists — every real island
 * worker, so timer/promise callbacks from libraries still hit their own
 * document; the most recent realm's doc as a final multi-realm fallback;
 * the pre-install global otherwise (a real document in happy-dom tests —
 * transparent to shell-side code, which never runs inside a realm task).
 */
export function installRealmDispatcher(): void {
  if (realmDispatcherInstalled) return;
  realmDispatcherInstalled = true;
  const g = globalThis as Record<string, unknown>;
  const prevDocument = g.document;
  const prevWindow = g.window;
  const prevElement = g.Element;
  // Explicit assignments override the fallback (never the in-realm doc) —
  // keeps pre-dispatcher semantics for out-of-realm code, and lets test
  // harnesses/suites restore globals by plain assignment.
  let docOverride: unknown;
  let winOverride: unknown;
  let elOverride: unknown;

  Object.defineProperty(g, 'document', {
    configurable: true,
    enumerable: true,
    get: () => activeRealmDoc() ?? docOverride ?? ambientDoc() ?? prevDocument,
    set: (v) => {
      docOverride = v;
    },
  });
  Object.defineProperty(g, 'window', {
    configurable: true,
    enumerable: true,
    get: () => {
      const doc = activeRealmDoc();
      if (doc !== undefined) return windowFacadeFor(doc).facade;
      if (winOverride !== undefined) return winOverride;
      const ambient = ambientDoc();
      return ambient !== undefined ? windowFacadeFor(ambient).facade : prevWindow;
    },
    set: (v) => {
      winOverride = v;
    },
  });
  // Workers lack the Element constructor — `x instanceof Element` inside a
  // library would ReferenceError. Point it at ProxyElement while a realm
  // doc is resolvable; real HTMLElement checks never run worker-side.
  Object.defineProperty(g, 'Element', {
    configurable: true,
    enumerable: true,
    get: () => {
      if (activeRealmDoc() !== undefined) return ProxyElement;
      if (elOverride !== undefined) return elOverride;
      return ambientDoc() !== undefined ? ProxyElement : prevElement;
    },
    set: (v) => {
      elOverride = v;
    },
  });
}

/**
 * Install this document as the realm's DOM surface — the entry point for
 * running real DOM-dependent libraries unmodified inside an island realm:
 *
 *   const doc = createProxyDocument(realm);
 *   installDomShim(doc);
 *   SomeVendorLib.mount(doc.body);  // uses document./window./innerHTML…
 *
 * Under the realm dispatcher (installed here automatically, and by
 * defineIslandWorker for every island worker) `globalThis.document` and
 * `globalThis.window` already resolve to this document while its realm is
 * active — so this call's real work is building the window facade
 * (navigator/location stubs, timers + rAF passthrough, innerWidth/Height
 * from the pushed container size, empty getComputedStyle, never-matching
 * matchMedia, addEventListener wired to `listen` ops on id 0) and exposing
 * it as `document.defaultView`.
 *
 * What does NOT get touched — deliberately:
 *  - `globalThis.addEventListener`/`removeEventListener` and `self` — the
 *    pool's `self.onmessage` channel lives there; `window` is a facade
 *    object, not the global.
 *  - Any other global (history, fetch, localStorage…) — libraries touching
 *    them fail loudly, which is the honest answer.
 *
 * Returns `uninstall()` tearing down the facade's listeners. Also runs
 * automatically on `doc.dispose()` (the updateProps rebuild path) and is
 * superseded by a later installDomShim call — the last install wins.
 */
export function installDomShim(doc: ProxyDocument): () => void {
  const internal = doc as InternalDocument;
  installRealmDispatcher();
  const g = globalThis as Record<string, unknown>;
  activeShimUninstall?.();
  activeShimUninstall = null;

  // Capture the ambient state BEFORE this doc claims it — uninstall puts
  // it all back, so chained installs restore true originals.
  const prevRealm = getLastActiveRealm();
  const prevDocument = g.document;
  const prevWindow = g.window;
  const prevElement = g.Element;

  // The installed document becomes the ambient one for out-of-realm
  // readers: the explicit assignment wins the dispatcher's resolution,
  // and the realm is marked for implicit resolution paths.
  markRealmActive(internal.realm);
  const bundle = windowFacadeFor(internal);
  g.document = doc;
  g.window = bundle.facade;
  g.Element = ProxyElement;

  const uninstall = (): void => {
    bundle.teardown();
    internal._windowBundle = undefined;
    g.document = prevDocument;
    g.window = prevWindow;
    g.Element = prevElement;
    markRealmActive(prevRealm);
    if (activeShimUninstall === uninstall) activeShimUninstall = null;
  };

  internal._uninstallShim = uninstall;
  activeShimUninstall = uninstall;
  return uninstall;
}
