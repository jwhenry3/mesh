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
  rejectForeignChild,
  detachFromParent,
  type ProxyEventHandler,
} from './node';
import { parseChildren, serializeNode } from './html';
import { parseSelector, matchCompound, matchesChain } from './selectors';
import { classListFor, styleProxyFor, datasetProxyFor, type ProxyClassList } from './css';
import type { InternalDocument } from './document';

/* ── ProxyElement ──────────────────────────────────────────────────────── */

/** Positions `insertAdjacentHTML`/`insertAdjacentElement` accept. */
export type AdjacentPosition = 'beforebegin' | 'afterbegin' | 'beforeend' | 'afterend';

export class ProxyElement extends ProxyNode {
  declare readonly instance: ElementInstance;
  readonly _attrs = new Map<string, string>();
  _classes = new Set<string>();
  readonly _styleProps: Record<string, string> = {};
  private readonly _listeners: Array<{ type: string; fn: ProxyEventHandler; hid: number }> = [];

  override get nodeType(): number {
    return 1;
  }
  get tagName(): string {
    return this.instance.type.toUpperCase();
  }
  /** Element children only — the shadow tree's HTMLCollection equivalent. */
  get children(): ProxyElement[] {
    return this._children.filter((c): c is ProxyElement => c instanceof ProxyElement);
  }

  get id(): string {
    return this._attrs.get('id') ?? '';
  }
  set id(v: string) {
    this._setAttr('id', v);
  }
  get className(): string {
    return this._attrs.get('class') ?? '';
  }
  set className(v: string) {
    this._setAttr('class', v);
  }

  getAttribute(name: string): string | null {
    return this._attrs.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this._attrs.has(name);
  }
  setAttribute(name: string, value: string): void {
    this._setAttr(name, value);
  }
  removeAttribute(name: string): void {
    this.doc._assertAlive();
    if (!this._attrs.has(name)) return;
    this._attrs.delete(name);
    this._afterAttrChange(name);
    this._op({ t: 'attr', id: this.instance.id, name, value: null });
  }

  /* classList — a live view over _classes synced to the `class` attr. */
  get classList(): ProxyClassList {
    return classListFor(this);
  }

  /**
   * Inline style — a Proxy over a plain prop record. Writes re-send only
   * the changed key; `delete style.x`/`style.removeProperty('x')` send ''
   * (the protocol's "clear this key"). `setProperty`/`getPropertyValue`
   * accept kebab-case and camelize it, like the real CSSStyleDeclaration.
   */
  get style(): CSSStyleDeclaration {
    return styleProxyFor(this);
  }

  /**
   * dataset — a Proxy mapping camelCase keys to `data-*` attribute ops.
   * `swatch.dataset.color = c` emits attr {name:'data-color', value:c};
   * `delete el.dataset.x` emits the removal form.
   */
  get dataset(): DOMStringMap {
    return datasetProxyFor(this);
  }

  /**
   * Focus/blur — NO-OPS. Real focus can't be delivered over async postMessage
   * (the driver's dispatch fires after the event; there is no focus op).
   * They exist because gesture libraries call `el.focus()` unconditionally
   * during mousedown paths (Leaflet's Keyboard handler does).
   */
  focus(): void {}
  blur(): void {}

  /* Events — registers a worker handler-table entry and emits listen.
   * The driver's listenerFor dispatches EventPayloads back into the worker;
   * the payload is enriched with a synthesized `target` proxy node first. */
  addEventListener(type: string, fn: ProxyEventHandler): void {
    this.doc._assertAlive();
    // The real DOM dedupes identical (type, listener) pairs — so do we.
    if (this._listeners.some((l) => l.type === type && l.fn === fn)) return;
    const hid = registerHandler(
      (p) => fn(this.doc._enrichEvent(p as EventPayload)),
      this.instance.realm,
      this.instance.id,
    );
    this._listeners.push({ type, fn, hid });
    this.doc._handlerIds.add(hid);
    this._op({ t: 'listen', id: this.instance.id, type, handler: hid });
  }
  removeEventListener(type: string, fn: ProxyEventHandler): void {
    this.doc._assertAlive();
    const index = this._listeners.findIndex((l) => l.type === type && l.fn === fn);
    if (index === -1) return;
    const [entry] = this._listeners.splice(index, 1);
    unregisterHandler(entry.hid);
    this.doc._handlerIds.delete(entry.hid);
    this._op({ t: 'unlisten', id: this.instance.id, type, handler: entry.hid });
  }

  /** Live-descendant search over the shadow tree. Nodes mounted by the
   *  reconciler aren't reachable (the op stream doesn't mirror React's
   *  structure into _children) — adopted subtrees match only their own
   *  proxy-built descendants. Class matching reads _classes AND the
   *  instance's serialized className prop, so adopted React elements with
   *  className set still match. */
  getElementsByClassName(name: string): ProxyElement[] {
    this.doc._assertAlive();
    const out: ProxyElement[] = [];
    const visit = (el: ProxyElement): void => {
      for (const child of el._children) {
        if (!(child instanceof ProxyElement)) continue;
        const viaProps = ((child.instance.props?.className as string | undefined) ?? '')
          .split(/\s+/)
          .includes(name);
        if (child._classes.has(name) || viaProps) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }

  getElementsByTagName(tag: string): ProxyElement[] {
    this.doc._assertAlive();
    const want = tag.toLowerCase();
    const out: ProxyElement[] = [];
    const visit = (el: ProxyElement): void => {
      for (const child of el._children) {
        if (!(child instanceof ProxyElement)) continue;
        if (want === '*' || child.instance.type.toLowerCase() === want) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }

  /* SVG measurement APIs — no layout/text engine exists worker-side, so
   *  these report honest zeros (warned once), exactly like the rest of the
   *  geometry surface. Libraries doing animation sizing (recharts'
   *  getTotalLength paths) degrade to instant/no animation. */
  getBBox(): {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    right: number;
    bottom: number;
    left: number;
  } {
    this.doc._assertAlive();
    this.doc._warn('getBBox');
    return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 };
  }

  getTotalLength(): number {
    this.doc._assertAlive();
    this.doc._warn('getTotalLength');
    return 0;
  }

  getComputedTextLength(): number {
    this.doc._assertAlive();
    this.doc._warn('getComputedTextLength');
    return 0;
  }

  /* Selector matching — compound selectors only (see parseSelector). */
  matches(selector: string): boolean {
    return matchesChain(this, parseSelector(selector));
  }

  /** Nearest element (self inclusive) matching the selector — walks the
   *  shadow tree upward through ancestors. */
  closest(selector: string): ProxyElement | null {
    const chain = parseSelector(selector);
    let n: ProxyNode | null = this;
    while (n !== null) {
      if (n instanceof ProxyElement && matchesChain(n, chain)) return n;
      n = n._parent;
    }
    return null;
  }

  /** Scoped local-tree query — descendants only, same engine and the same
   *  supported-selector subset as document.querySelectorAll. */
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
    walk(this);
    return out;
  }

  /* ── innerHTML + friends: real HTML parsing worker-side ──────────────── */

  /** Serialized shadow-tree children — the only innerHTML there CAN be over
   *  an async op channel (it reflects writes made through this facade, not
   *  the real DOM's current markup). */
  get innerHTML(): string {
    return this._children.map((child) => serializeNode(child)).join('');
  }
  get outerHTML(): string {
    return serializeNode(this);
  }
  /**
   * Parse `html` worker-side (htmlparser2 — pure JS, worker-safe) and
   * rebuild this element's children as proxy nodes: each parsed element is
   * createElement + setAttribute + recursive children, each text run a
   * createTextNode — all emitting ordinary create/attr/append ops. Existing
   * children are removed first (one remove op each). Comments and
   * directives are skipped.
   */
  set innerHTML(html: string) {
    this.doc._assertAlive();
    for (const child of this._children.slice()) this.removeChild(child);
    for (const node of parseChildren(this.doc, html)) this.appendChild(node);
  }

  /**
   * Parse `html` and insert the resulting nodes relative to this element —
   * 'beforebegin'/'afterend' require a parent and no-op without one (like
   * the DOM on detached elements).
   */
  insertAdjacentHTML(position: AdjacentPosition, html: string): void {
    this.doc._assertAlive();
    this._insertAt(position, parseChildren(this.doc, html));
  }

  /** insertAdjacentElement — returns the inserted element like the DOM. */
  insertAdjacentElement(position: AdjacentPosition, el: ProxyElement): ProxyElement | null {
    this.doc._assertAlive();
    if (!(el instanceof ProxyElement)) return null;
    this._insertAt(position, [el]);
    return el;
  }

  private _insertAt(position: AdjacentPosition, nodes: ProxyNode[]): void {
    switch (position) {
      case 'beforebegin': {
        if (this._parent === null) return;
        for (const n of nodes) this._parent.insertBefore(n, this);
        return;
      }
      case 'afterbegin': {
        const ref = this.firstChild;
        for (const n of nodes) this.insertBefore(n, ref);
        return;
      }
      case 'beforeend': {
        for (const n of nodes) this.appendChild(n);
        return;
      }
      case 'afterend': {
        if (this._parent === null) return;
        const ref = this.nextSibling;
        for (const n of nodes) this._parent.insertBefore(n, ref);
        return;
      }
      default:
        throw new Error(`proxyDom.insertAdjacent*: unknown position "${String(position)}"`);
    }
  }

  /**
   * Clone as new ops — the copy gets its own instance id (it's a real new
   * element on the main thread, not a shared record). Attributes and the
   * style-proxy properties are copied; listeners are NOT (matches the DOM).
   * `deep` clones element children recursively and text children as fresh
   * text nodes.
   */
  cloneNode(deep?: boolean): ProxyElement {
    this.doc._assertAlive();
    const copy = this.doc.createElement(this.instance.type);
    for (const [name, value] of this._attrs) copy.setAttribute(name, value);
    for (const [k, v] of Object.entries(this._styleProps)) copy._writeStyle(k, v);
    if (deep === true) {
      for (const child of this._children) {
        if (child instanceof ProxyElement) copy.appendChild(child.cloneNode(true));
        else if (child instanceof ProxyText) copy.appendChild(this.doc.createTextNode(child.textContent));
      }
    }
    return copy;
  }

  /** append(...nodes) — strings become text nodes, like the DOM. */
  append(...nodes: Array<ProxyNode | string>): void {
    this.doc._assertAlive();
    for (const n of nodes) {
      this.appendChild(typeof n === 'string' ? this.doc.createTextNode(n) : n);
    }
  }

  /** prepend(...nodes) — inserts at the front, in argument order. */
  prepend(...nodes: Array<ProxyNode | string>): void {
    this.doc._assertAlive();
    const ref = this.firstChild;
    for (const n of nodes) {
      this.insertBefore(typeof n === 'string' ? this.doc.createTextNode(n) : n, ref);
    }
  }

  /** replaceChildren(...nodes) — remove every child, then append the set. */
  replaceChildren(...nodes: Array<ProxyNode | string>): void {
    this.doc._assertAlive();
    for (const child of this._children.slice()) this.removeChild(child);
    this.append(...nodes);
  }

  /* ── Pushed-size geometry. The ONLY measured box is the island container:
   *  `doc.body`/`documentElement` and markContainer()ed elements report the
   *  last setSize push; everything else keeps the honest 0 and warns once
   *  per document per API. A marked element reports the CONTAINER's box —
   *  the driver can only measure the island's root, so "marked" means
   *  "pretend my box is the container's", which is only honest for elements
   *  that genuinely fill it. ── */
  getBoundingClientRect(): DOMRect {
    const size = this.doc._sizeFor(this);
    if (size === undefined) {
      this.doc._warn('getBoundingClientRect');
      return {
        x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return {
      x: 0, y: 0, top: 0, left: 0, right: size.w, bottom: size.h,
      width: size.w, height: size.h,
      toJSON: () => ({}),
    } as DOMRect;
  }
  get clientWidth(): number {
    return this._geom('clientWidth', (s) => s.w);
  }
  get clientHeight(): number {
    return this._geom('clientHeight', (s) => s.h);
  }
  get offsetWidth(): number {
    return this._geom('offsetWidth', (s) => s.w);
  }
  get offsetHeight(): number {
    return this._geom('offsetHeight', (s) => s.h);
  }
  /** Border edge widths — honestly 0 (the pushed box doesn't measure borders). */
  get clientLeft(): number {
    return 0;
  }
  get clientTop(): number {
    return 0;
  }
  /** Position within offsetParent — not measured; 0 is honest for root-level boxes. */
  get offsetLeft(): number {
    return 0;
  }
  get offsetTop(): number {
    return 0;
  }
  get offsetParent(): null {
    return null;
  }
  get scrollTop(): number {
    this.doc._warn('scrollTop');
    return 0;
  }
  set scrollTop(_v: number) {
    this.doc._warn('scrollTop');
  }
  get scrollLeft(): number {
    this.doc._warn('scrollLeft');
    return 0;
  }
  set scrollLeft(_v: number) {
    this.doc._warn('scrollLeft');
  }
  get scrollHeight(): number {
    this.doc._warn('scrollHeight');
    return 0;
  }
  get scrollWidth(): number {
    this.doc._warn('scrollWidth');
    return 0;
  }

  /**
   * Reflected properties. Library code assigns `img.src = url`,
   * `el.tabIndex = 0`, `link.href = '#'` — on a bare class instance those
   * become silent expandos and nothing crosses the wire. The attribute-backed
   * accessors below (defined for the properties real libraries poke) make
   * those assignments emit ordinary `attr` ops. Everything else still falls
   * through to a plain own-property — which is also exactly what library
   * expandos like `_leaflet_pos` need, so proxy elements are deliberately
   * NOT frozen/sealed.
   */
  get src(): string {
    return this._attrs.get('src') ?? '';
  }
  set src(v: string) {
    this._setAttr('src', v);
  }
  get srcset(): string {
    return this._attrs.get('srcset') ?? '';
  }
  set srcset(v: string) {
    this._setAttr('srcset', v);
  }
  get href(): string {
    return this._attrs.get('href') ?? '';
  }
  set href(v: string) {
    this._setAttr('href', v);
  }
  get alt(): string {
    return this._attrs.get('alt') ?? '';
  }
  set alt(v: string) {
    this._setAttr('alt', v);
  }
  get title(): string {
    return this._attrs.get('title') ?? '';
  }
  set title(v: string) {
    this._setAttr('title', v);
  }
  get tabIndex(): number {
    return Number(this._attrs.get('tabindex') ?? -1);
  }
  set tabIndex(v: number) {
    this._setAttr('tabindex', String(v));
  }
  get draggable(): boolean {
    return this._attrs.get('draggable') === 'true';
  }
  set draggable(v: boolean) {
    this._setAttr('draggable', String(v));
  }
  get crossOrigin(): string | null {
    return this._attrs.get('crossorigin') ?? null;
  }
  set crossOrigin(v: string | null) {
    if (v === null) this.removeAttribute('crossorigin');
    else this._setAttr('crossorigin', v);
  }
  get width(): number {
    return Number(this._attrs.get('width') ?? 0);
  }
  set width(v: number) {
    this._setAttr('width', String(v));
  }
  get height(): number {
    return Number(this._attrs.get('height') ?? 0);
  }
  set height(v: number) {
    this._setAttr('height', String(v));
  }
  get type(): string {
    return this._attrs.get('type') ?? '';
  }
  set type(v: string) {
    this._setAttr('type', v);
  }
  get loading(): string {
    return this._attrs.get('loading') ?? '';
  }
  set loading(v: string) {
    this._setAttr('loading', v);
  }
  get decoding(): string {
    return this._attrs.get('decoding') ?? '';
  }
  set decoding(v: string) {
    this._setAttr('decoding', v);
  }
  get value(): string {
    return this._attrs.get('value') ?? '';
  }
  set value(v: string) {
    this._setAttr('value', v);
  }
  get checked(): boolean {
    return this._attrs.has('checked');
  }
  set checked(v: boolean) {
    if (v) this._setAttr('checked', '');
    else this.removeAttribute('checked');
  }
  get disabled(): boolean {
    return this._attrs.has('disabled');
  }
  set disabled(v: boolean) {
    if (v) this._setAttr('disabled', '');
    else this.removeAttribute('disabled');
  }

  /* internals */
  /** Geometry read shared by the pushed-size getters above. */
  _geom(feature: string, pick: (size: { w: number; h: number }) => number): number {
    const size = this.doc._sizeFor(this);
    if (size === undefined) {
      this.doc._warn(feature);
      return 0;
    }
    return pick(size);
  }
  _writeStyle(key: string, value: string): void {
    this.doc._assertAlive();
    if (this._styleProps[key] === value) return;
    this._styleProps[key] = value;
    this._op({ t: 'style', id: this.instance.id, props: { [key]: value } });
  }
  private _setAttr(name: string, value: string): void {
    this.doc._assertAlive();
    const v = String(value);
    if (this._attrs.get(name) === v) return; // unchanged → no op
    this._attrs.set(name, v);
    this._afterAttrChange(name);
    this._op({ t: 'attr', id: this.instance.id, name, value: v });
  }
  private _afterAttrChange(name: string): void {
    if (name === 'class') {
      this._classes = new Set((this._attrs.get('class') ?? '').split(/\s+/).filter(Boolean));
    } else if (name === 'id') {
      this.doc._trackId(this);
    }
  }
}

