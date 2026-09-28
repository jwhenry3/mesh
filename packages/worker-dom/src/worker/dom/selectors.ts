import { ProxyElement } from './element';
import type { ProxyNode } from './node';

/* ── Selectors (compound + descendant combinator only) ─────────────────── */

interface CompoundSelector {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: Array<{ name: string; value?: string }>;
}

const unsupportedSelector = (sel: string): never => {
  throw new Error(
    `proxyDom.querySelector: unsupported selector "${sel}" — only tag, .class, #id, [attr], [attr="v"] and descendant combinators are supported`,
  );
};

export function parseCompound(part: string, sel: string): CompoundSelector {
  const out: CompoundSelector = { classes: [], attrs: [] };
  let i = 0;
  const tag = /^[a-zA-Z][\w-]*/.exec(part);
  if (tag !== null) {
    out.tag = tag[0].toLowerCase();
    i = tag[0].length;
  }
  while (i < part.length) {
    const ch = part[i];
    if (ch === '#') {
      const m = /^[\w-]+/.exec(part.slice(i + 1));
      if (m === null) unsupportedSelector(sel);
      out.id = m![0];
      i += 1 + m![0].length;
    } else if (ch === '.') {
      const m = /^[\w-]+/.exec(part.slice(i + 1));
      if (m === null) unsupportedSelector(sel);
      out.classes.push(m![0]);
      i += 1 + m![0].length;
    } else if (ch === '[') {
      const end = part.indexOf(']', i);
      if (end === -1) unsupportedSelector(sel);
      const body = part.slice(i + 1, end).trim();
      const m = /^([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^'"\s]+)))?$/.exec(body);
      if (m === null) unsupportedSelector(sel);
      out.attrs.push({ name: m![1], value: m![2] ?? m![3] ?? m![4] });
      i = end + 1;
    } else {
      unsupportedSelector(sel);
    }
  }
  if (
    out.tag === undefined &&
    out.id === undefined &&
    out.classes.length === 0 &&
    out.attrs.length === 0
  ) {
    unsupportedSelector(sel);
  }
  return out;
}

export function parseSelector(selector: string): CompoundSelector[] {
  const sel = selector.trim();
  if (
    sel === '' ||
    sel.includes(',') ||
    sel.includes('>') ||
    sel.includes('+') ||
    sel.includes('~') ||
    sel.includes(':')
  ) {
    unsupportedSelector(selector);
  }
  return sel.split(/\s+/).map((part) => parseCompound(part, selector));
}

export function matchCompound(el: ProxyElement, c: CompoundSelector): boolean {
  if (c.tag !== undefined && el.tagName.toLowerCase() !== c.tag) return false;
  if (c.id !== undefined && el._attrs.get('id') !== c.id) return false;
  for (const cls of c.classes) if (!el._classes.has(cls)) return false;
  for (const a of c.attrs) {
    const v = el._attrs.get(a.name);
    if (v === undefined) return false;
    if (a.value !== undefined && v !== a.value) return false;
  }
  return true;
}

/** `el` matches the last compound; each earlier compound must match some
 *  ancestor above the previous match — the descendant combinator. */
export function matchesChain(el: ProxyElement, chain: CompoundSelector[]): boolean {
  if (!matchCompound(el, chain[chain.length - 1])) return false;
  let cur: ProxyNode | null = el._parent;
  for (let i = chain.length - 2; i >= 0; i--) {
    let found = false;
    while (cur !== null) {
      if (cur instanceof ProxyElement && matchCompound(cur, chain[i])) {
        found = true;
        cur = cur._parent;
        break;
      }
      cur = cur._parent;
    }
    if (!found) return false;
  }
  return true;
}

