/**
 * React-reconciler host adapter for the worker DOM backend.
 *
 * The generic realm state (op queues, instance ids, handler registry,
 * doorbell, geometry) lives in `realm.ts`. This file only wires the
 * reconciler's create/append/update/remove/commit hooks to that backend.
 *
 * react-reconciler@0.34 reads ~150 fields off the config object. Most are
 * stubs for features this renderer doesn't implement (hydration,
 * persistence, resources, singletons, view transitions, test selectors,
 * scope/hydratable APIs) — they exist so nothing throws when the reconciler
 * destructures them; they are never invoked behind the `supports*` flags.
 */

import { createContext } from 'react';
import {
  bumpOpsVersion,
  getActiveRealm,
  getLastActiveRealm,
  instances,
  pushOp,
  serializeProps,
  unregisterHandler,
  type ElementInstance,
  type HostInstance,
  type RootContainer,
  type TextInstance,
} from './realm';
import { newElement, newText } from './realm';
import { realmDocFor, type ProxyNode } from './proxyDom';

/* ── Event-priority plumbing ────────────────────────────────────────────── */
/*
 * React 19 expresses event priorities as lane numbers: 2 = discrete
 * (click/keydown → SyncLane), 8 = continuous, 32 = default, 0 = none. The
 * reconciler calls setCurrentUpdatePriority around its own flushes
 * (flushSyncFromReconciler sets 2), so honoring the set/get pair and echoing
 * the value back from resolveUpdatePriority is all that's needed.
 */
let currentUpdatePriority = 0;
const DEFAULT_EVENT_PRIORITY = 32;

/* ── React-19 transition context (must be real React objects) ───────────── */

const NotPendingTransition = Object.freeze({ pending: false, data: null, method: null, action: null });
const HostTransitionContext = createContext(NotPendingTransition);

const noop = (): void => {};
const NULL = (): null => null;
const FALSE = (): boolean => false;
const TRUE = (): boolean => true;

/* ── Refs & portals ───────────────────────────────────────────────────────
 *
 * React refs must receive an object the COMPONENT treats as "the element" —
 * for React DOM that's the real DOM node, for us the closest truthful thing
 * is the proxy DOM's facade (it navigates the shadow tree, mutates via ops,
 * and reports `nodeType === 1`). getPublicInstance therefore adopts the
 * host instance into a per-realm proxy document, created lazily so React
 * realms only pay for it when something actually holds a ref.
 *
 * This is what makes react-dom's `createPortal(children, ref.current)` work
 * here: isValidContainer() only checks nodeType, the portal fiber then feeds
 * the facade back as `containerInfo`, and the container-level methods below
 * unwrap `.instance` so portal children land inside the real target node —
 * that is the entire recharts <Tooltip>/<Legend> path.
 */
const publicInstanceFor = (instance: HostInstance): ProxyNode | HostInstance =>
  realmDocFor(instance.realm).adopt(instance);

/**
 * Portal `containerInfo` is the public instance (a ProxyElement) the caller
 * passed to createPortal; the ROOT_CONTAINER sentinel and raw instances keep
 * their own `id`. Anything unrecognizable falls back to the island root.
 */
const containerParentId = (container: unknown): number => {
  const inst = (container as { instance?: { id?: unknown } } | null)?.instance;
  if (inst && typeof inst.id === 'number') return inst.id;
  const id = (container as { id?: unknown } | null)?.id;
  return typeof id === 'number' ? id : 0;
};

/**
 * The realm a create should bind to — read off the root container for
 * ordinary renders, off the portal container's wrapped instance for portal
 * subtrees (a ProxyElement, whose `.realm` field doesn't exist but whose
 * `.instance.realm` does), finally falling back to ambient realm state.
 */
const containerRealm = (container: unknown): string => {
  const c = container as (RootContainer & { instance?: { realm?: string } }) | null;
  return c?.realm ?? c?.instance?.realm ?? (getActiveRealm() !== '' ? getActiveRealm() : getLastActiveRealm());
};

/* Host context = DOM namespace tracking, same role it plays in React DOM:
 * `getChildHostContext` flips the namespace when the element type requires
 * it, and `createInstance` stamps the result on the instance so the `create`
 * op can tell the driver to createElementNS. Recharts-style SVG trees need
 * this — without it every <svg>/<path> would arrive as an HTMLUnknownElement. */
interface HostContext {
  ns?: string;
}
const SVG_NS = 'http://www.w3.org/2000/svg';
const MATH_NS = 'http://www.w3.org/1998/Math/MathML';
const HTML_CTX: HostContext = Object.freeze({});
const SVG_CTX: HostContext = Object.freeze({ ns: SVG_NS });
const MATH_CTX: HostContext = Object.freeze({ ns: MATH_NS });

/** The namespace context a host element gives its children — and the
 *  namespace the element itself belongs to (getChildNamespace semantics:
 *  <svg> in HTML is SVG, foreignObject/desc/title flip back to HTML). */
const childHostContextFor = (parent: HostContext, type: string): HostContext => {
  if (type === 'svg') return SVG_CTX;
  if (type === 'math') return MATH_CTX;
  if (type === 'foreignObject' || type === 'desc' || type === 'title') return HTML_CTX;
  return parent;
};

/* ── The host config ────────────────────────────────────────────────────── */

export const hostConfig = {
  // Identity / capabilities
  rendererVersion: '0.34.0',
  rendererPackageName: '@jwhenry123/mesh-worker-dom',
  extraDevToolsConfig: null,
  isPrimaryRenderer: true,
  warnsIfNotActing: false,
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  supportsResources: false,
  supportsSingletons: false,
  supportsMicrotasks: false,
  supportsTestSelectors: false,

  getPublicInstance: (instance: HostInstance): unknown => publicInstanceFor(instance),
  // Host contexts must be non-null objects (the reconciler pushes them on a
  // context stack and warns "Expected host context to exist" on null). This
  // renderer carries no per-subtree context — echo a single frozen sentinel.
  // Host contexts must be non-null objects (the reconciler warns on null).
  // Ours carries only the element namespace: <svg>/<math> enter their
  // namespaces; foreignObject/desc/title are HTML-integration points that
  // flip children back to HTML; everything else inherits the parent's.
  // For portals, this becomes the context the portal subtree renders under —
  // derived from the container's own namespace so children of an SVG portal
  // target (recharts zIndex <g> layers) stay in the SVG namespace.
  getRootHostContext: (container: unknown): HostContext => {
    const ns = (container as { instance?: { ns?: string } } | null)?.instance?.ns;
    if (ns === SVG_NS) return SVG_CTX;
    if (ns === MATH_NS) return MATH_CTX;
    return HTML_CTX;
  },
  getChildHostContext: (parent: HostContext, type: string): HostContext =>
    childHostContextFor(parent, type),
  prepareForCommit: NULL,
  // The doorbell: every commit bumps opsVersion once — the main thread's
  // observe() wakes (Atomics.waitAsync) and flushes the op queue, so commits
  // made outside task calls (effects, timers, async setState) arrive as a
  // push instead of waiting on a poll. Task-returned ops bump too; the
  // follow-up flush just finds an empty queue.
  resetAfterCommit: bumpOpsVersion,

  // Creation — emit ops
  createInstance: (
    type: string,
    props: Record<string, unknown>,
    rootContainer: unknown,
    hostContext: unknown,
    _internalHandle: unknown,
  ): ElementInstance => {
    // The element's own namespace = the child context its TYPE produces
    // under the parent's context — the same computation React DOM runs
    // (getChildNamespace): <svg> in HTML is itself SVG, <foreignObject> in
    // SVG is itself HTML. Realm comes from the container (see RootContainer).
    const ctx = childHostContextFor(hostContext as HostContext, type);
    const instance = newElement(type, props, ctx.ns, containerRealm(rootContainer));
    pushOp(instance.realm, {
      t: 'create',
      id: instance.id,
      type,
      props: instance.props,
      ns: instance.ns,
    });
    return instance;
  },
  createTextInstance: (
    text: string,
    rootContainer: unknown,
    _hostContext: unknown,
    _internalHandle: unknown,
  ): TextInstance => {
    const instance = newText(text, containerRealm(rootContainer));
    pushOp(instance.realm, { t: 'text', id: instance.id, text });
    return instance;
  },
  finalizeInitialChildren: FALSE,
  // Always false: string/number children become real text instances, so the
  // tree arrives as linear ops and `utext` handles every text update. (The
  // `true` path would expect commitUpdate to set textContent from
  // props.children — which we deliberately never serialize.)
  shouldSetTextContent: FALSE,

  // Tree wiring — emit ops
  appendInitialChild: (parent: HostInstance, child: HostInstance): void => {
    pushOp(parent.realm, { t: 'append', parent: parent.id, child: child.id });
  },
  appendChild: (parent: HostInstance, child: HostInstance): void => {
    pushOp(parent.realm, { t: 'append', parent: parent.id, child: child.id });
  },
  appendChildToContainer: (container: unknown, child: HostInstance): void => {
    pushOp(child.realm, { t: 'append', parent: containerParentId(container), child: child.id });
  },
  insertBefore: (parent: HostInstance, child: HostInstance, before: HostInstance): void => {
    pushOp(parent.realm, { t: 'append', parent: parent.id, child: child.id, before: before.id });
  },
  insertInContainerBefore: (container: unknown, child: HostInstance, before: HostInstance): void => {
    pushOp(child.realm, {
      t: 'append',
      parent: containerParentId(container),
      child: child.id,
      before: before.id,
    });
  },
  removeChild: (_parent: HostInstance, child: HostInstance): void => {
    pushOp(child.realm, { t: 'remove', child: child.id });
  },
  removeChildFromContainer: (_container: unknown, child: HostInstance): void => {
    pushOp(child.realm, { t: 'remove', child: child.id });
  },
  // No instance argument — routed by the task's active realm (only reached
  // inside mount/remount's syncCommit).
  clearContainer: (): void => {
    pushOp(getActiveRealm(), { t: 'clear' });
  },

  // Updates — emit ops
  commitUpdate: (
    instance: ElementInstance,
    _type: string,
    _oldProps: Record<string, unknown>,
    newProps: Record<string, unknown>,
    _internalHandle: unknown,
  ): void => {
    // Serialize first so the op carries the latest props; re-serialization
    // also re-registers event handlers against the current closure.
    instance.props = serializeProps(instance, newProps);
    pushOp(instance.realm, { t: 'update', id: instance.id, props: instance.props });
  },
  commitTextUpdate: (instance: TextInstance, _oldText: string, newText: string): void => {
    instance.text = newText;
    pushOp(instance.realm, { t: 'utext', id: instance.id, text: newText });
  },
  commitMount: noop,
  // Unreachable while shouldSetTextContent is always false; still emit the
  // spec'd op for completeness.
  resetTextContent: (instance: ElementInstance): void => {
    instance.props = {};
    pushOp(instance.realm, { t: 'update', id: instance.id, props: {} });
  },

  // Suspense visibility — `hidden` is a global HTML attribute the main
  // thread applies like any other prop.
  hideInstance: (instance: ElementInstance): void => {
    pushOp(instance.realm, { t: 'update', id: instance.id, props: { ...instance.props, hidden: true } });
  },
  unhideInstance: (instance: ElementInstance): void => {
    pushOp(instance.realm, { t: 'update', id: instance.id, props: { ...instance.props } });
  },
  hideTextInstance: (instance: TextInstance): void => {
    pushOp(instance.realm, { t: 'utext', id: instance.id, text: '' });
  },
  unhideTextInstance: (instance: TextInstance, text: string): void => {
    pushOp(instance.realm, { t: 'utext', id: instance.id, text });
  },

  // GC hook — drop the record and its handler slots.
  detachDeletedInstance: (instance: HostInstance): void => {
    instances.delete(instance.id);
    if (instance.kind === 'element') {
      for (const hid of Object.values(instance.listenerSlots)) unregisterHandler(hid);
    }
  },

  // Scheduler
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  // supportsMicrotasks is false, so the reconciler schedules root work via
  // the `scheduler` package (MessageChannel in a worker). This export is
  // still destructured — provide a real one for completeness.
  scheduleMicrotask: (fn: () => void): void => queueMicrotask(fn),

  // Event priorities (see note above — values are lane numbers).
  setCurrentUpdatePriority: (p: number): void => {
    currentUpdatePriority = p;
  },
  getCurrentUpdatePriority: (): number => currentUpdatePriority,
  resolveUpdatePriority: (): number =>
    currentUpdatePriority !== 0 ? currentUpdatePriority : DEFAULT_EVENT_PRIORITY,
  resolveEventType: NULL,
  resolveEventTimeStamp: (): number => -1.1,
  trackSchedulerEvent: noop,
  shouldAttemptEagerTransition: FALSE,

  // Events/portals/scopes — no DOM event system exists worker-side.
  getInstanceFromNode: NULL,
  beforeActiveInstanceBlur: noop,
  afterActiveInstanceBlur: noop,
  preparePortalMount: noop,
  prepareScopeUpdate: noop,
  getInstanceFromScope: NULL,

  // React 19 "suspend on commit" — never suspend.
  requestPostPaintCallback: noop,
  maySuspendCommit: FALSE,
  maySuspendCommitOnUpdate: FALSE,
  maySuspendCommitInSyncRender: FALSE,
  preloadInstance: TRUE,
  startSuspendingCommit: noop,
  suspendInstance: noop,
  suspendOnActiveViewTransition: noop,
  waitForCommitToBeReady: NULL,
  getSuspendedCommitReason: () => 0,

  // Transitions / forms / console
  NotPendingTransition,
  HostTransitionContext,
  resetFormInstance: noop,
  bindToConsole: (methodName: string, args: unknown[]) =>
    (console as unknown as Record<string, (...a: unknown[]) => void>)[methodName]?.bind(console, ...args) ??
    noop,

  // Persistence (supportsPersistence: false — destructured, never called)
  createContainerChildSet: () => [],
  appendChildToContainerChildSet: noop,
  finalizeContainerChildren: noop,
  replaceContainerChildren: noop,
  cloneInstance: NULL,
  cloneMutableInstance: (instance: HostInstance) => instance,
  cloneMutableTextInstance: (instance: HostInstance) => instance,
  cloneHiddenInstance: (instance: HostInstance) => instance,
  cloneHiddenTextInstance: (instance: HostInstance) => instance,

  // Fragment instances (only used for `<Fragment ref={…}>` — unimplemented)
  createFragmentInstance: () => ({}),
  updateFragmentInstanceFiber: noop,
  commitNewChildToFragmentInstance: noop,
  deleteChildFromFragmentInstance: noop,

  // View transitions (React 19) — all stubs
  createViewTransitionInstance: (name: string) => ({ name, autoName: null }),
  applyViewTransitionName: noop,
  restoreViewTransitionName: noop,
  cancelViewTransitionName: noop,
  cancelRootViewTransitionName: noop,
  restoreRootViewTransitionName: noop,
  cloneRootViewTransitionContainer: noop,
  removeRootViewTransitionClone: noop,
  measureInstance: NULL,
  measureClonedInstance: NULL,
  wasInstanceInViewport: FALSE,
  hasInstanceChanged: FALSE,
  hasInstanceAffectedParent: FALSE,
  startViewTransition: NULL,
  startGestureTransition: NULL,
  stopViewTransition: noop,
  addViewTransitionFinishedListener: noop,
  getCurrentGestureOffset: () => 0,

  // Hydration (supportsHydration: false — destructured, never called)
  isSuspenseInstancePending: FALSE,
  isSuspenseInstanceFallback: FALSE,
  getSuspenseInstanceFallbackErrorDetails: () => ({}),
  registerSuspenseInstanceRetry: noop,
  getNextHydratableSibling: NULL,
  getNextHydratableSiblingAfterSingleton: NULL,
  getFirstHydratableChild: NULL,
  getFirstHydratableChildWithinContainer: NULL,
  getFirstHydratableChildWithinActivityInstance: NULL,
  getFirstHydratableChildWithinSingleton: NULL,
  getFirstHydratableChildWithinSuspenseInstance: NULL,
  canHydrateInstance: NULL,
  canHydrateTextInstance: NULL,
  canHydrateActivityInstance: NULL,
  canHydrateSuspenseInstance: NULL,
  canHydrateFormStateMarker: NULL,
  isFormStateMarkerMatching: FALSE,
  hydrateInstance: noop,
  hydrateTextInstance: noop,
  hydrateActivityInstance: noop,
  hydrateSuspenseInstance: noop,
  getNextHydratableInstanceAfterActivityInstance: NULL,
  getNextHydratableInstanceAfterSuspenseInstance: NULL,
  commitHydratedInstance: noop,
  commitHydratedContainer: noop,
  commitHydratedSuspenseInstance: noop,
  finalizeHydratedChildren: FALSE,
  flushHydrationEvents: noop,
  clearActivityBoundary: FALSE,
  clearSuspenseBoundary: FALSE,
  clearActivityBoundaryFromContainer: FALSE,
  clearSuspenseBoundaryFromContainer: FALSE,
  hideDehydratedBoundary: noop,
  unhideDehydratedBoundary: noop,
  shouldDeleteUnhydratedTailInstances: FALSE,
  diffHydratedPropsForDevWarnings: NULL,
  diffHydratedTextForDevWarnings: NULL,
  describeHydratableInstanceForDevWarnings: NULL,
  validateHydratableInstance: TRUE,
  validateHydratableTextInstance: TRUE,

  // Host resources (stylesheets/scripts — supportsResources: false)
  isHostHoistableType: FALSE,
  getHoistableRoot: NULL,
  getResource: NULL,
  acquireResource: noop,
  releaseResource: noop,
  hydrateHoistable: noop,
  mountHoistable: noop,
  unmountHoistable: noop,
  createHoistableInstance: NULL,
  prepareToCommitHoistables: noop,
  mayResourceSuspendCommit: FALSE,
  preloadResource: TRUE,
  suspendResource: noop,

  // Singletons (supportsSingletons: false)
  resolveSingletonInstance: NULL,
  acquireSingletonInstance: noop,
  releaseSingletonInstance: noop,
  isHostSingletonType: FALSE,
  isSingletonScope: FALSE,

  // Test selectors (supportsTestSelectors: false)
  findFiberRoot: NULL,
  getBoundingRect: NULL,
  getTextContent: NULL,
  isHiddenSubtree: FALSE,
  matchAccessibilityRole: FALSE,
  setFocusIfFocusable: FALSE,
  setupIntersectionObserver: noop,
};
