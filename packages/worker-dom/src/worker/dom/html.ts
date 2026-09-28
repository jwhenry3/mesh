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
import { parseDocument, ElementType } from 'htmlparser2';

import { ProxyNode, ProxyText, hyphenate } from './node';
import { ProxyElement } from './element';
import type { InternalDocument } from './document';

/* ── HTML: parse (htmlparser2) + serialize (shadow tree) ───────────────── */

/**
 * Parse an HTML fragment into fresh proxy nodes — one createElement/
 * createTextNode/appendChild chain per parsed node, so setting innerHTML or
 * calling insertAdjacentHTML emits the same op stream hand-built code
 * would. htmlparser2 is pure JS — no DOM, worker-safe.
 */
/** A node in htmlparser2's parse tree — typed off the public API so no
 *  transitive domhandler import is needed. */
type ParsedNode = ReturnType<typeof parseDocument>['children'][number];

export function parseChildren(doc: InternalDocument, html: string): ProxyNode[] {
  const parsed = parseDocument(String(html));
  const build = (nodes: readonly ParsedNode[]): ProxyNode[] => {
    const out: ProxyNode[] = [];
    for (const node of nodes) {
      switch (node.type) {
        case ElementType.Tag:
        case ElementType.Script:
        case ElementType.Style: {
          const el = doc.createElement(node.name);
          for (const [name, value] of Object.entries(node.attribs)) el.setAttribute(name, value);
          for (const child of build(node.children)) el.appendChild(child);
          out.push(el);
          break;
        }
        case ElementType.Text: {
          if (node.data !== '') out.push(doc.createTextNode(node.data));
          break;
        }
        case ElementType.CDATA: {
          // CDATA carries its text as children — flatten like the DOM does.
          for (const child of build(node.children)) out.push(child);
          break;
        }
        default:
          break; // comments/directives/doctype: skipped.
      }
    }
    return out;
  };
  return build(parsed.children);
}

/** Elements the HTML serializer emits without an end tag. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const escapeText = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** Serialize a shadow node — elements with attrs (+ inline style from the
 *  style proxy), text escaped. Reads the shadow tree only; nothing the
 *  proxy didn't write appears here. */
export function serializeNode(node: ProxyNode): string {
  if (node instanceof ProxyText) return escapeText(node.textContent);
  if (!(node instanceof ProxyElement)) return '';
  const tag = node.instance.type;
  const attrs = new Map(node._attrs);
  const styleText = Object.entries(node._styleProps)
    .map(([k, v]) => `${hyphenate(k)}: ${v};`)
    .join(' ');
  if (styleText !== '') attrs.set('style', styleText);
  let out = `<${tag}`;
  for (const [name, value] of attrs) out += ` ${name}="${escapeAttr(value)}"`;
  if (VOID_ELEMENTS.has(tag)) return `${out}>`;
  out += '>';
  for (const child of node._children) out += serializeNode(child);
  return `${out}</${tag}>`;
}

