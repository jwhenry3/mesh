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
  ProxyNode,
  ProxyText,
  ProxyFragment,
  allocPhantomId,
  type ProxyEventHandler,
} from './node';
import { ProxyElement } from './element';
import type { ProxyClassList } from './css';
import { parseChildren, serializeNode } from './html';
import { parseSelector, matchCompound, matchesChain } from './selectors';
import type { WindowShim, WindowFacadeBundle } from './window';

/* ── The document ──────────────────────────────────────────────────────── */

export interface ProxyDocument {
  /**
   * The island's root container — driver-side id 0. `body` and
   * `documentElement` are aliases of it; appending to either lands elements
   * at the island root. Its own attr/style/listen mutations target the real
   * container element.
   */
  readonly body: ProxyElement;
  readonly documentElement: ProxyElement;
  createElement(tag: string): ProxyElement;
  /**
   * Namespaced creation for SVG/MathML trees — the `create` op carries the
   * namespace so the driver uses `createElementNS`. Needed by libraries that
   * build SVG imperatively (d3-style code).
   */
  createElementNS(ns: string, tag: string): ProxyElement;
  createTextNode(text: string): ProxyText;
  /**
   * A phantom container for batching — appending the fragment splices its
   * children into the target like the DOM does (each child emits its own
   * append op). Fragments never exist driver-side.
   */
  createDocumentFragment(): ProxyFragment;
  /**
   * Document-level listeners: emitted as `listen` ops on id 0 — the driver
   * attaches them to the island's real container element, so delegated
   * handlers see every event that bubbles inside the island. This is what
   * library-style `document.addEventListener('click', delegate)` needs.
   */
  addEventListener(type: string, fn: ProxyEventHandler): void;
  removeEventListener(type: string, fn: ProxyEventHandler): void;
  /** id-map lookup over the CONNECTED shadow tree (disconnected nodes with
   *  an id set are remembered but not returned, matching real-DOM scoping). */
  getElementById(id: string): ProxyElement | null;
  /** Simple matcher: tag/.class/#id/[attr]/[attr="v"] + descendant
   *  combinators. Anything else throws a clear unsupported-selector error. */
  querySelector(selector: string): ProxyElement | null;
  querySelectorAll(selector: string): ProxyElement[];
  /** Wrap an existing host-instance record (e.g. a React-rendered element
   *  reached via the shared `instances` map) so imperative code can navigate
   *  or mutate around it — the bridge for nesting proxy trees inside
   *  React-rendered parents and vice versa. */
  adopt(instance: HostInstance): ProxyNode;
  /**
   * Mark `el` as reporting the pushed container size — the driver's only
   * measured box is the island container, so geometry reads
   * (`clientWidth/Height`, `offsetWidth/Height`, `getBoundingClientRect`)
   * on marked elements return the last `setSize` push exactly like
   * `doc.body`/`documentElement`. Only honest for elements that actually
   * fill the island's box (a map viewport, a canvas host).
   */
  markContainer(el: ProxyElement): void;
  /**
   * Register a handler fired every time the driver pushes a new container
   * size — the app's resize signal. Handlers run inside the realm's task
   * scope, so their proxy-DOM mutations emit ops and `emit` routes.
   */
  onResize(cb: (w: number, h: number) => void): void;
  /**
   * The window facade `installDomShim` installed this document under —
   * what `document.defaultView` reads as (`window.getComputedStyle` etc).
   * undefined until the shim installs.
   */
  readonly defaultView?: WindowShim;
  /** No measurement channel — returns an all-empty declaration (warns once). */
  getComputedStyle(el: ProxyElement): CSSStyleDeclaration;
  /** Unregister every handler this document's listeners hold. Called by the
   *  worker on rebuild so stale handler ids can't be dispatched into dead
   *  nodes; mutating a disposed document throws. */
  dispose(): void;
}

export class InternalDocument implements ProxyDocument {
  readonly realm: string;
  readonly _root: ProxyElement;
  readonly _wrappers = new Map<number, ProxyNode>();
  readonly _ids = new Map<string, ProxyElement>();
  /** handler ids this document registered — disposed on rebuild. */
  readonly _handlerIds = new Set<number>();
  /**
   * instance ids geometry reads answer for — id 0 (the root) plus every
   * markContainer()ed element. The pushed box is the ISLAND CONTAINER's,
   * so a marked element claims "my box is the container's box".
   */
  readonly _containerIds = new Set<number>([0]);
  /** Handlers fired when a setSize task pushes a new container size. */
  private readonly _resizeHandlers = new Set<(w: number, h: number) => void>();
  /** The window facade bundle — built lazily by windowFacadeFor, shared by
   *  installDomShim and the realm dispatcher. */
  _windowBundle?: WindowFacadeBundle;
  /** what `document.defaultView` reads as (`window.getComputedStyle` etc). */
  get defaultView(): WindowShim | undefined {
    return this._windowBundle?.facade;
  }
  /** Document-level listeners — separate table from the root element's, so
   *  doc.addEventListener and body.addEventListener don't wrongly dedupe
   *  against each other. Both emit `listen` on id 0. */
  private readonly _docListeners: Array<{ type: string; fn: ProxyEventHandler; hid: number }> = [];
  private readonly _warned = new Set<string>();
  _disposed = false;
  /** Set by installDomShim — restore globals when this document dies. */
  _uninstallShim: (() => void) | null = null;

  constructor(realm: string) {
    this.realm = realm;
    // id 0 is the driver-side island container sentinel — deliberately NOT
    // registered in `instances` (the driver's nodes map already maps 0 → el).
    this._root = new ProxyElement(this, {
      kind: 'element',
      id: 0,
      type: '#root',
      realm,
      props: {},
      listenerSlots: {},
    });
    this._wrappers.set(0, this._root);
  }

  get body(): ProxyElement {
    return this._root;
  }
  get documentElement(): ProxyElement {
    return this._root;
  }

  /** No hit-testing exists worker-side — honest null (a11y-layer probing). */
  elementFromPoint(_x: number, _y: number): null {
    this._assertAlive();
    this._warn('elementFromPoint');
    return null;
  }

  _assertAlive(): void {
    if (this._disposed) {
      throw new Error(
        'proxyDom: this document was disposed by an updateProps/remount rebuild — its nodes are detached',
      );
    }
  }

  _warn(feature: string): void {
    if (this._warned.has(feature)) return;
    this._warned.add(feature);
    console.warn(
      `[proxyDom] '${feature}' has no measurement channel — the only geometry the worker sees is the pushed container size (setSize); reads on unmarked elements return 0/empty.`,
    );
  }

  markContainer(el: ProxyElement): void {
    this._assertAlive();
    this._containerIds.add(el.instance.id);
  }

  /**
   * The size a geometry read on `el` may report: the pushed container box
   * when `el` is the root or was markContainer()ed, undefined otherwise
   * (also undefined when nothing has been pushed yet — reads return 0).
   */
  _sizeFor(el: ProxyElement): { w: number; h: number } | undefined {
    if (!this._containerIds.has(el.instance.id)) return undefined;
    return getRealmSize(this.realm);
  }

  onResize(cb: (w: number, h: number) => void): void {
    this._assertAlive();
    this._resizeHandlers.add(cb);
  }

  /**
   * Fire the doc's resize handlers — the worker's `setSize` task calls this
   * inside the realm's scope, so handler mutations emit ops on the realm
   * queue and come back in the task's return batch.
   */
  _notifySize(w: number, h: number): void {
    for (const cb of [...this._resizeHandlers]) cb(w, h);
  }

  /** Keep the getElementById map pointing at each element's CURRENT id. */
  _trackId(el: ProxyElement): void {
    for (const [k, v] of this._ids) if (v === el) this._ids.delete(k);
    const id = el._attrs.get('id');
    if (id !== undefined && id !== '') this._ids.set(id, el);
  }

  /** The synthetic text child an element's `textContent` setter leaves in
   *  the shadow tree — no driver-side node, so its writes retarget parent. */
  _phantomText(parent: ProxyNode, text: string): ProxyText {
    const t = new ProxyText(this, {
      kind: 'text',
      id: allocPhantomId(),
      text,
      realm: parent.instance.realm,
    });
    t._parent = parent;
    return t;
  }

  /**
   * Enrich a dispatched payload before handing it to a proxy listener:
   *  - `target` = the proxy node for targetId, looked up in the shared
   *    instance space and wrapped in THIS document's wrapper map (so
   *    `e.target.closest`/`.dataset`/`.contains` behave like the real DOM
   *    for proxy-created nodes).
   *  - `preventDefault`/`stopPropagation`/`stopImmediatePropagation` =
   *    synthesized NO-OPS. They cannot cancel anything — the real event
   *    already dispatched on the main thread before this payload crossed
   *    postMessage — but library code written against real DOM events calls
   *    them unconditionally, so the wrapper supplies them.
   */
  _enrichEvent(payload: EventPayload): EventPayload {
    const out: EventPayload = {
      ...payload,
      preventDefault: () => {},
      stopPropagation: () => {},
      stopImmediatePropagation: () => {},
    };
    const id = payload.targetId;
    if (typeof id === 'number') {
      const instance = instances.get(id);
      if (instance !== undefined) out.target = this._wrap(instance);
    }
    return out;
  }

  createElement(tag: string): ProxyElement {
    return this._newElement(tag.toLowerCase(), undefined);
  }

  createElementNS(ns: string, tag: string): ProxyElement {
    return this._newElement(tag, ns);
  }

  private _newElement(type: string, ns: string | undefined): ProxyElement {
    this._assertAlive();
    const instance: ElementInstance = {
      kind: 'element',
      id: allocId(),
      type,
      ns,
      realm: this.realm,
      props: {},
      listenerSlots: {},
    };
    instances.set(instance.id, instance);
    pushOp(this.realm, { t: 'create', id: instance.id, type: instance.type, props: {}, ns: instance.ns });
    if (getActiveRealm() !== this.realm) bumpOpsVersion();
    return this._wrap(instance) as ProxyElement;
  }

  createTextNode(text: string): ProxyText {
    this._assertAlive();
    const instance: TextInstance = {
      kind: 'text',
      id: allocId(),
      text: String(text),
      realm: this.realm,
    };
    instances.set(instance.id, instance);
    pushOp(this.realm, { t: 'text', id: instance.id, text: instance.text });
    if (getActiveRealm() !== this.realm) bumpOpsVersion();
    return this._wrap(instance) as ProxyText;
  }

  adopt(instance: HostInstance): ProxyNode {
    this._assertAlive();
    return this._wrap(instance);
  }

  createDocumentFragment(): ProxyFragment {
    this._assertAlive();
    return new ProxyFragment(this, {
      kind: 'element',
      id: allocPhantomId(),
      type: '#fragment',
      realm: this.realm,
      props: {},
      listenerSlots: {},
    });
  }

  /** Wrap (or return the existing wrapper for) a shared instance record. */
  _wrap(instance: HostInstance): ProxyNode {
    let node = this._wrappers.get(instance.id);
    if (node === undefined) {
      node =
        instance.kind === 'text'
          ? new ProxyText(this, instance)
          : new ProxyElement(this, instance as ElementInstance);
      this._wrappers.set(instance.id, node);
    }
    return node;
  }

  /**
   * Document-level listener — same currency as element addEventListener but
   * targeting id 0 (the island's container element). The driver's listen op
   * attaches a real DOM listener on the container, so events bubbling up
   * from any island child dispatch back here. Used by library code doing
   * delegated `document.addEventListener(...)`.
   */
  addEventListener(type: string, fn: ProxyEventHandler): void {
    this._assertAlive();
    if (this._docListeners.some((l) => l.type === type && l.fn === fn)) return;
    const hid = registerHandler(
      (p) => fn(this._enrichEvent(p as EventPayload)),
      this.realm,
      0, // document-level listener → currentTarget is the island root
    );
    this._docListeners.push({ type, fn, hid });
    this._handlerIds.add(hid);
    pushOp(this.realm, { t: 'listen', id: 0, type, handler: hid });
    if (getActiveRealm() !== this.realm) bumpOpsVersion();
  }

  removeEventListener(type: string, fn: ProxyEventHandler): void {
    this._assertAlive();
    const index = this._docListeners.findIndex((l) => l.type === type && l.fn === fn);
    if (index === -1) return;
    const [entry] = this._docListeners.splice(index, 1);
    unregisterHandler(entry.hid);
    this._handlerIds.delete(entry.hid);
    pushOp(this.realm, { t: 'unlisten', id: 0, type, handler: entry.hid });
    if (getActiveRealm() !== this.realm) bumpOpsVersion();
  }

  getElementById(id: string): ProxyElement | null {
    const el = this._ids.get(id);
    return el !== undefined && el.isConnected ? el : null;
  }

  querySelector(selector: string): ProxyElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): ProxyElement[] {
    const chain = parseSelector(selector);
    const out: ProxyElement[] = [];
    const walk = (node: ProxyNode): void => {
      for (const child of node._children) {
        if (child instanceof ProxyElement && matchesChain(child, chain)) out.push(child);
        walk(child);
      }
    };
    walk(this._root);
    return out;
  }

  getComputedStyle(_el: ProxyElement): CSSStyleDeclaration {
    this._warn('getComputedStyle');
    // Every property reads ''; getPropertyValue('x') returns '' too.
    return new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => (prop === 'getPropertyValue' ? () => '' : ''),
    }) as unknown as CSSStyleDeclaration;
  }

  dispose(): void {
    // Tear down the shim FIRST if this doc was installed — the rebuild path
    // (updateProps) swaps in a fresh doc and re-installs.
    this._uninstallShim?.();
    this._uninstallShim = null;
    this._disposed = true;
    if (realmDocs.get(this.realm) === this) realmDocs.delete(this.realm);
    this._resizeHandlers.clear();
    for (const hid of this._handlerIds) unregisterHandler(hid);
    this._handlerIds.clear();
  }
}

/**
 * A fresh proxy document scoped to one realm — created per imperative
 * mount and per rebuild (updateProps). Mutations emit ops onto the realm's
 * queue immediately; reads are served from the shadow tree.
 */
/**
 * realm key → the proxy document for that realm. `createProxyDocument` is
 * the only creator — imperative apps get one at mount, React realms lazily
 * via `getPublicInstance` — so global `document`/`window`/`Element` can
 * dispatch to the right realm's document (see installRealmDispatcher).
 */
const realmDocs = new Map<string, InternalDocument>();

export const createProxyDocument = (realm: string): ProxyDocument => {
  const doc = new InternalDocument(realm);
  realmDocs.set(realm, doc);
  return doc;
};

/**
 * The realm's proxy document, creating it lazily — the getPublicInstance
 * path (React realms only need a document when a library holds a ref or a
 * portal target).
 */
export const realmDocFor = (realm: string): InternalDocument =>
  realmDocs.get(realm) ?? (createProxyDocument(realm) as InternalDocument);

/**
 * The document `globalThis.document` should mean right now: the active
 * realm's when a task holds one; the single registered document when only
 * one realm exists (every real island worker — timers and promise
 * continuations run outside realm tasks but unambiguously belong to it);
 * the most recently active realm's otherwise (multi-realm in-process tests
 * still route deferred library callbacks sensibly).
 */
export const activeRealmDoc = (): InternalDocument | undefined => realmDocs.get(getActiveRealm());

/** The ambient document: the sole registered doc, or the most recently
 *  active realm's — for out-of-task readers (timers, continuations). */
export const ambientDoc = (): InternalDocument | undefined =>
  realmDocs.size === 1
    ? realmDocs.values().next().value
    : realmDocs.get(getLastActiveRealm());

const docForCurrentContext = (): InternalDocument | undefined =>
  activeRealmDoc() ?? ambientDoc();

