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

import type { InternalDocument, ProxyDocument } from './document';

/** Handler signature for proxy addEventListener — the wire payload plus a
 *  synthesized `target` (the proxy node for `targetId`, when known). */
export type ProxyEventHandler = (payload: EventPayload) => void;

export const hyphenate = (k: string): string => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
export const camelize = (k: string): string => k.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

/**
 * Phantom instance ids — negative, so they can never collide with allocId's
 * positive ids and are never registered in `instances`. A phantom is the
 * synthetic text child an element's `textContent` setter leaves in the
 * shadow tree (the real DOM gets the same effect from `utext` on the
 * parent, which is why phantom mutations retarget the parent — see below).
 */
let nextPhantomId = -1;
export const allocPhantomId = (): number => nextPhantomId--;

/**
 * A node that isn't a ProxyNode can only arrive via a foreign `document`
 * (the dispatcher's real-DOM fallback or a poisoned override) — typically a
 * library's deferred callback running after its realm was torn down, or
 * globals restored while worker-side timers still fire. Adopting it would
 * crash later on `child.instance`; reject it here with the actual cause.
 */
export const rejectForeignChild = (child: unknown): never => {
  throw new Error(
    'proxyDom.insertBefore: child is not a proxy node — the ambient `document`/' +
      '`createElement` resolved a foreign DOM (a stale override or the real one), ' +
      'so this node was created outside the realm that owns the parent',
  );
};

/**
 * Detach `child` from its recorded parent, tolerating a stale/foreign
 * `_parent` link (undefined, or a non-proxy object) instead of crashing on
 * `_detach` — a corrupted link is cleared, a valid one is honored.
 */
export const detachFromParent = (child: ProxyNode): void => {
  const p = child._parent;
  if (p instanceof ProxyNode) p._detach(child);
  else child._parent = null;
};

/* ── ProxyNode ─────────────────────────────────────────────────────────── */

export class ProxyNode {
  /** The shared host-instance record — same objects `instances` holds. */
  readonly instance: HostInstance;
  /** The document that created/wrapped this node (internal fields below). */
  readonly doc: InternalDocument;
  _parent: ProxyNode | null = null;
  _children: ProxyNode[] = [];

  constructor(doc: InternalDocument, instance: HostInstance) {
    this.doc = doc;
    this.instance = instance;
  }

  get nodeType(): number {
    return 0;
  }

  /** The proxy document that owns this node — what real DOM code reads as
   *  `el.ownerDocument`. */
  get ownerDocument(): ProxyDocument {
    return this.doc;
  }

  get parentNode(): ProxyNode | null {
    return this._parent;
  }
  get parentElement(): ProxyNode | null {
    // structural Element check — importing ProxyElement here would create a
    // module cycle because ProxyElement extends ProxyNode.
    return this._parent !== null && this._parent.nodeType === 1 ? this._parent : null;
  }
  /** A copy of the shadow child list — structural changes go through
   *  appendChild/insertBefore/removeChild so ops stay in sync. */
  get childNodes(): ProxyNode[] {
    return this._children.slice();
  }
  get firstChild(): ProxyNode | null {
    return this._children[0] ?? null;
  }
  get lastChild(): ProxyNode | null {
    return this._children[this._children.length - 1] ?? null;
  }
  get nextSibling(): ProxyNode | null {
    const p = this._parent;
    if (p === null) return null;
    return p._children[p._children.indexOf(this) + 1] ?? null;
  }
  get previousSibling(): ProxyNode | null {
    const p = this._parent;
    if (p === null) return null;
    const i = p._children.indexOf(this);
    return i > 0 ? p._children[i - 1] : null;
  }
  /** Attached to the document's root (driver-side id 0 container)? */
  get isConnected(): boolean {
    let n: ProxyNode | null = this;
    while (n !== null) {
      if (n === this.doc._root) return true;
      n = n._parent;
    }
    return false;
  }

  /**
   * The topmost shadow-tree ancestor — the root container element when the
   * node is connected. (The facade has no separate Document node object;
   * `doc.body`/`documentElement` ARE that root.)
   */
  getRootNode(): ProxyNode {
    let n: ProxyNode = this;
    while (n._parent !== null) n = n._parent;
    return n;
  }

  /** Concatenated descendant text — walked from the shadow tree. */
  get textContent(): string {
    let out = '';
    for (const child of this._children) out += child.textContent;
    return out;
  }
  set textContent(value: string) {
    this.doc._assertAlive();
    const text = String(value);
    for (const child of this._children) child._parent = null;
    this._children = text === '' ? [] : [this.doc._phantomText(this, text)];
    this._op({ t: 'utext', id: this.instance.id, text });
  }

  contains(other: ProxyNode): boolean {
    let n: ProxyNode | null = other;
    while (n !== null) {
      if (n === this) return true;
      n = n._parent;
    }
    return false;
  }

  appendChild<T extends ProxyNode>(child: T): T {
    return this.insertBefore(child, null);
  }

  insertBefore<T extends ProxyNode>(child: T, ref: ProxyNode | null): T {
    this.doc._assertAlive();
    if (!(child instanceof ProxyNode)) rejectForeignChild(child);
    // A fragment is a phantom PARENT — the real DOM splices its children
    // in at the insertion point and empties it; do the same (per-child ops).
    if (child instanceof ProxyFragment) {
      for (const c of child._children.slice()) this.insertBefore(c, ref);
      return child;
    }
    let beforeId: number | undefined;
    if (ref === null) {
      detachFromParent(child);
      child._parent = this;
      this._children.push(child);
    } else {
      const index = this._children.indexOf(ref);
      if (index === -1) {
        throw new Error('proxyDom.insertBefore: reference node is not a child of this node');
      }
      detachFromParent(child);
      child._parent = this;
      this._children.splice(index, 0, child);
      if (ref.instance.id > 0) beforeId = ref.instance.id;
    }
    // Phantom nodes (fragments, shadow-only texts) have NEGATIVE ids and no
    // driver-side counterpart — skip ops when either endpoint is phantom.
    // Id 0 is NOT phantom: it's the island's real root container.
    if (this.instance.id >= 0 && child.instance.id > 0) {
      this._op({ t: 'append', parent: this.instance.id, child: child.instance.id, before: beforeId });
    }
    return child;
  }

  removeChild<T extends ProxyNode>(child: T): T {
    this.doc._assertAlive();
    const index = this._children.indexOf(child);
    if (index === -1) {
      throw new Error('proxyDom.removeChild: node is not a child of this node');
    }
    this._children.splice(index, 1);
    child._parent = null;
    if (this.instance.id >= 0 && child.instance.id > 0) {
      this._op({ t: 'remove', child: child.instance.id });
    }
    return child;
  }

  /** Detach from the parent — no-op when already orphaned (like the DOM). */
  remove(): void {
    this._parent?.removeChild(this);
  }

  /**
   * Queue an op on this node's realm — the same routing hostConfig uses for
   * instance-bound ops. Outside a realm task the op still lands on the right
   * queue, and the doorbell is bumped so push-mode islands pick it up.
   */
  _op(op: Op): void {
    pushOp(this.instance.realm, op);
    if (getActiveRealm() !== this.instance.realm) bumpOpsVersion();
  }

  /** Detach a child from the shadow list WITHOUT emitting an op — used when
   *  a following append op will move the real node on the main thread. */
  _detach(child: ProxyNode): void {
    const i = this._children.indexOf(child);
    if (i !== -1) this._children.splice(i, 1);
    child._parent = null;
  }
}

/* ── ProxyText ─────────────────────────────────────────────────────────── */

export class ProxyText extends ProxyNode {
  declare readonly instance: TextInstance;

  constructor(doc: InternalDocument, instance: TextInstance) {
    super(doc, instance);
  }

  override get nodeType(): number {
    return 3;
  }

  /**
   * The driver-side id a text write targets. Real text instances write
   * their own id; phantoms (created by an element's `textContent` setter)
   * have no driver-side node, so writes retarget the parent — whose real
   * `textContent` IS this node's whole text.
   */
  get _utextTarget(): number {
    return this.instance.id > 0
      ? this.instance.id
      : (this._parent?.instance.id ?? this.instance.id);
  }

  get data(): string {
    return this.instance.text;
  }
  set data(v: string) {
    this._write(v);
  }
  get nodeValue(): string {
    return this.instance.text;
  }
  set nodeValue(v: string) {
    this._write(v);
  }
  override get textContent(): string {
    return this.instance.text;
  }
  override set textContent(v: string) {
    this._write(v);
  }

  private _write(v: string): void {
    this.doc._assertAlive();
    const text = String(v);
    this.instance.text = text;
    this._op({ t: 'utext', id: this._utextTarget, text });
  }
}

/* ── ProxyFragment ─────────────────────────────────────────────────────── */

/**
 * DocumentFragment — a PHANTOM parent: it never exists driver-side, so its
 * `instance.id` is negative (no ops ever target it). Appending it to a real
 * parent splices its children out like the DOM does; libraries use it to
 * batch insertions (Leaflet's GridLayer builds each zoom level in one).
 */
export class ProxyFragment extends ProxyNode {
  override get nodeType(): number {
    return 11;
  }
}

