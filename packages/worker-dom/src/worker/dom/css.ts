import { ProxyElement } from './element';
import { camelize, hyphenate } from './node';

/** The small subset of DOMTokenList the proxy implements. */
export interface ProxyClassList {
  add(...tokens: string[]): void;
  remove(...tokens: string[]): void;
  toggle(token: string, force?: boolean): boolean;
  contains(token: string): boolean;
  readonly value: string;
}

const classLists = new WeakMap<ProxyElement, ProxyClassList>();
const styles = new WeakMap<ProxyElement, CSSStyleDeclaration>();
const datasets = new WeakMap<ProxyElement, DOMStringMap>();

/** Push the current set of classes back to the `class` attribute op. */
function syncClasses(el: ProxyElement): void {
  const v = [...el._classes].join(' ');
  el._attrs.set('class', v);
  el._op({ t: 'attr', id: el.instance.id, name: 'class', value: v === '' ? null : v });
}

/** Build (or reuse) a live classList view for the element. */
export function classListFor(el: ProxyElement): ProxyClassList {
  let cl = classLists.get(el);
  if (cl === undefined) {
    cl = {
      add: (...tokens) => {
        let changed = false;
        for (const t of tokens) {
          if (t !== '' && !el._classes.has(t)) {
            el._classes.add(t);
            changed = true;
          }
        }
        if (changed) syncClasses(el);
      },
      remove: (...tokens) => {
        let changed = false;
        for (const t of tokens) changed = el._classes.delete(t) || changed;
        if (changed) syncClasses(el);
      },
      toggle: (token, force) => {
        const has = el._classes.has(token);
        const want = force ?? !has;
        if (want === has) return has;
        if (want) el._classes.add(token);
        else el._classes.delete(token);
        syncClasses(el);
        return want;
      },
      contains: (token) => el._classes.has(token),
      get value() {
        return el._attrs.get('class') ?? '';
      },
    };
    classLists.set(el, cl);
  }
  return cl;
}

/**
 * Build (or reuse) a live CSSStyleDeclaration proxy. Writes re-send only the
 * changed key; `delete style.x`/`style.removeProperty('x')` send '' (the
 * protocol's "clear this key"). `setProperty`/`getPropertyValue` accept
 * kebab-case and camelize it, like the real CSSStyleDeclaration.
 */
export function styleProxyFor(el: ProxyElement): CSSStyleDeclaration {
  let style = styles.get(el);
  if (style === undefined) {
    style = new Proxy(el._styleProps as Record<string, unknown>, {
      get: (t, prop) => {
        if (prop === 'setProperty') {
          return (k: string, v: string) => el._writeStyle(camelize(k), v);
        }
        if (prop === 'removeProperty') return (k: string) => el._writeStyle(camelize(k), '');
        if (prop === 'getPropertyValue') return (k: string) => t[camelize(k)] ?? '';
        if (prop === 'cssText') {
          return Object.entries(t)
            .map(([k, v]) => `${hyphenate(k)}: ${v};`)
            .join(' ');
        }
        if (typeof prop === 'string') return t[prop] ?? '';
        return undefined;
      },
      set: (_t, prop, v) => {
        if (typeof prop === 'string') el._writeStyle(prop, String(v));
        return true;
      },
      deleteProperty: (_t, prop) => {
        if (typeof prop === 'string') el._writeStyle(prop, '');
        return true;
      },
      has: (t, prop) => prop in t,
      ownKeys: (t) => Reflect.ownKeys(t),
      getOwnPropertyDescriptor: (t, prop) =>
        typeof prop === 'string' && prop in t
          ? { configurable: true, enumerable: true, value: t[prop] }
          : undefined,
    }) as unknown as CSSStyleDeclaration;
    styles.set(el, style);
  }
  return style;
}

/**
 * Build (or reuse) a live DOMStringMap proxy. camelCase keys map to `data-*`
 * attribute ops: `el.dataset.foo = 'x'` sets `data-foo`, `delete el.dataset.foo`
 * removes it.
 */
export function datasetProxyFor(el: ProxyElement): DOMStringMap {
  let ds = datasets.get(el);
  if (ds === undefined) {
    ds = new Proxy({} as Record<string, string>, {
      get: (_t, prop) => {
        if (typeof prop !== 'string') return undefined;
        return el.getAttribute(`data-${hyphenate(prop)}`) ?? undefined;
      },
      set: (_t, prop, v) => {
        if (typeof prop === 'string') el.setAttribute(`data-${hyphenate(prop)}`, v);
        return true;
      },
      deleteProperty: (_t, prop) => {
        if (typeof prop === 'string') el.removeAttribute(`data-${hyphenate(prop)}`);
        return true;
      },
      has: (_t, prop) =>
        typeof prop === 'string' && el._attrs.has(`data-${hyphenate(prop)}`),
      ownKeys: () =>
        [...el._attrs.keys()].filter((k) => k.startsWith('data-')).map((k) => camelize(k.slice(5))),
      getOwnPropertyDescriptor: (_t, prop) => {
        if (typeof prop !== 'string') return undefined;
        const v = el.getAttribute(`data-${hyphenate(prop)}`);
        return v === null ? undefined : { configurable: true, enumerable: true, value: v };
      },
    }) as unknown as DOMStringMap;
    datasets.set(el, ds);
  }
  return ds;
}
