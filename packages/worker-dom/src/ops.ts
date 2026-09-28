/**
 * The whole protocol between the two threads.
 *
 * The worker runs a real React reconciler whose "host environment" is a set
 * of records in a Map — every render-phase and mutation-phase host-config
 * call appends one of these ops to a queue. Task methods (`mount`,
 * `updateProps`, `dispatch`, `flush`) return the flushed batch, and the main
 * thread's only job is to replay them against the DOM. Ops ride postMessage —
 * no shared memory is involved.
 *
 * ISLANDS: every island owns an independent op stream — instance ids are only
 * unique within one worker, so each island's driver keeps its own node map
 * (see src/island.ts). `emit` is the one op that is NOT a DOM mutation: it is
 * the island→shell event channel — the driver hands `{name, payload}` to the
 * shell-registered `onEvent` callback instead of touching the DOM.
 */
export type Op =
  /**
   * createElement-equivalent — `props` is already wire-serialized. `ns` is
   * the element's namespace URI when it isn't HTML ('http://www.w3.org/2000/svg',
   * 'http://www.w3.org/1998/Math/MathML') — the driver calls
   * `createElementNS(ns, type)`. The reconciler's host context tracks it
   * (svg/math enter, foreignObject/desc/title return to HTML), so SVG trees
   * like recharts' arrive correctly namespaced.
   */
  | { t: 'create'; id: number; type: string; props: WireProps; ns?: string }
  /** createTextNode-equivalent. */
  | { t: 'text'; id: number; text: string }
  /** `parent.insertBefore(child, before ?? null)` — parent 0 is the root container. */
  | { t: 'append'; parent: number; child: number; before?: number }
  /** Detach `child` from wherever it is mounted. */
  | { t: 'remove'; child: number }
  /** Re-serialized full prop set for `id` (main diffs against its last seen set). */
  | { t: 'update'; id: number; props: WireProps }
  /** New text content for a text instance. Also how the proxy DOM writes
   *  `element.textContent` — the driver assigns `node.textContent`, which
   *  replaces the element's children with a single text node. */
  | { t: 'utext'; id: number; text: string }
  /** Clear the root container (React's clearContainer, or an imperative
   *  realm's rebuild). */
  | { t: 'clear' }
  /**
   * Set/remove a single attribute — emitted by the worker-side proxy DOM
   * (`setAttribute`, `id`/`className` setters, `classList`, `dataset`).
   * `value: null` removes the attribute.
   */
  | { t: 'attr'; id: number; name: string; value: string | null }
  /**
   * Merge inline-style changes — the proxy DOM's `style` proxy re-sends only
   * the changed keys; `''` clears a key (deleteProperty).
   */
  | { t: 'style'; id: number; props: Record<string, string> }
  /**
   * Attach a DOM listener for a proxy-DOM `addEventListener` — `handler` is
   * a worker handler-table id (same currency as `__evt` refs); the driver
   * wires it to `client.dispatch(handler, payload)`. `id: 0` targets the
   * island's root container — that's where `document`/`window` listeners
   * land, which makes delegated handlers work.
   */
  | { t: 'listen'; id: number; type: string; handler: number }
  /** Detach the listener a `listen` op attached (type + handler identify it). */
  | { t: 'unlisten'; id: number; type: string; handler: number }
  /**
   * Island → shell event — worker code calls `emit(name, payload)` inside a
   * handler (or a commit-phase effect); the driver invokes the island's
   * `onEvent(name, payload)` instead of mutating the DOM. Payloads must be
   * structured-cloneable — same rule as props.
   */
  | { t: 'emit'; name: string; payload?: unknown };

/**
 * Wire-serialized props. Functions named `on*` (onClick, onInput, …) cross as
 * `{ __evt: handlerId }`; the main thread turns that into a DOM listener that
 * dispatches back into the worker. `children` never crosses — tree structure
 * is expressed entirely by append/remove ops.
 *
 * One prop is NOT a normal attribute: `data-mesh-slot` marks a transclusion
 * slot — a leaf element whose box is worker-owned but whose contents the
 * shell mounts main-thread DOM into (the island's `slots` registry). The
 * driver routes it to the slot machinery instead of treating it like any
 * other data attribute.
 */
export type WireProps = Record<string, unknown>;

/** Marker for a prop that was a function — a handle into the worker's handler table. */
export interface EventRef {
  __evt: number;
}

export const isEventRef = (v: unknown): v is EventRef =>
  typeof v === 'object' && v !== null && '__evt' in v;

/**
 * What the main thread sends back when a DOM event fires. Deliberately NOT a
 * SyntheticEvent — just a best-effort handful of fields read off the DOM
 * event and its target. Mouse fields are `undefined` for non-mouse events;
 * `targetId` is only set when the event target is an op-created node (shell-
 * owned slot content has no instance id).
 */
export interface EventPayload {
  type: string;
  value?: string;
  checked?: boolean;
  key?: string;
  clientX?: number;
  clientY?: number;
  screenX?: number;
  screenY?: number;
  button?: number;
  /**
   * UIEvent.which — non-standard but set by every browser (1 = left button,
   * 2 = middle, 3 = right). Libraries like Leaflet's Draggable gate on it:
   * `e.which !== 1 && e.button !== 1` must not both hold for a left press.
   */
  which?: number;
  /** Modifier states for the event (KeyboardEvent/MouseEvent share them). */
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  /** WheelEvent deltas — only set for `wheel` events (deltaMode is always
   *  0/pixels in practice; reported raw). */
  deltaX?: number;
  deltaY?: number;
  /**
   * WheelEvent.deltaMode (0 = pixels, 1 = lines, 2 = pages). Libraries like
   * Leaflet gate on `e.deltaMode === 0` inside getWheelDelta, so the driver
   * always sends a concrete number — defaulting to 0 when the environment
   * doesn't expose it but deltas exist.
   */
  deltaMode?: number;
  /** PointerEvent.pointerType ('mouse' | 'touch' | 'pen' | ''). */
  pointerType?: string;
  /** `target.scrollTop` when the target is an element. */
  scrollTop?: number;
  /** The worker instance id of `event.target`, when it maps to one. */
  targetId?: number;
  /**
   * The proxy-DOM node for `targetId` — SYNTHESIZED worker-side by the proxy
   * DOM when it wraps a listener (it never crosses the wire). Lets delegated
   * handlers written for the real DOM — `e.target.closest('.row')`,
   * `e.target.dataset` — run unmodified. Only set when the target maps to a
   * known worker instance; DOM-fidelity only for nodes built through the
   * same proxy document.
   */
  target?: unknown;
  /**
   * Synthesized NO-OPS — added worker-side by the proxy DOM when it wraps a
   * listener's payload (they never cross the wire). They exist so library
   * code written for real DOM events — `e.preventDefault()`,
   * `e.stopPropagation()` — doesn't crash. They CANNOT cancel anything: the
   * real event already dispatched on the main thread before this payload
   * ever reached the worker. Practical consequence: a `wheel` listener on a
   * scrolling island can't preventDefault — the page scrolls anyway.
   */
  preventDefault?(): void;
  stopPropagation?(): void;
  stopImmediatePropagation?(): void;
}

/**
 * The task methods every island worker exposes — what `defineIslandWorker`
 * registers on the worker side and what `connectIslandWorker`'s typed client
 * calls on the main thread. Every signature leads with the realm key
 * (`'app'` or `'app@instance'`) — `mountIsland` binds it per island.
 */
export type IslandWorkerMethods = {
  /** Mount the realm's registry app; returns the initial op batch. */
  mount(realm: string, props?: Record<string, unknown>): Op[];
  /** Re-render the realm's root with new serializable props. */
  updateProps(realm: string, props: Record<string, unknown>): Op[];
  /** Invoke the worker handler a `__evt` ref or `listen` op points at. */
  dispatch(handlerId: number, payload: EventPayload): Op[];
  /**
   * Push the island container's measured box into the realm — the ONLY
   * geometry channel that exists. The driver observes the island's `el`
   * with a ResizeObserver and calls this once at mount and on resizes
   * (throttled ~100ms). The realm stores {w,h}; proxy-DOM geometry reads on
   * `doc.body`/`documentElement` and on elements marked via
   * `doc.markContainer(el)` then return it — deeper elements keep the
   * honest 0. Handlers registered via `doc.onResize` re-run on each push;
   * their ops ride back in this method's return batch.
   */
  setSize(realm: string, width: number, height: number): Op[];
  /** Drain ops committed outside a task (passive effects, timers). */
  flush(realm: string): Op[];
  /**
   * Tear down one realm — unmounts its tree / disposes its proxy document
   * and drops the realm, leaving the worker alive for its other realms.
   * Returned ops are the detach batch (the driver may skip applying them if
   * the island element is already gone).
   */
  unmount(realm: string): Op[];
  /** The mounted realm's random id — the island's "worker pid" badge. */
  whoami(realm: string): string;
};
