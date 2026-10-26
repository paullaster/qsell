/**
 * A small XML reader for business documents (UBL orders and invoices). It refuses what makes XML dangerous: DOCTYPE and entity
 * declarations (so no external entities and no expansion bombs), processing instructions other than the XML declaration, and
 * anything beyond fixed limits on size, depth and element count. Names are returned without their namespace prefix.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

export const XML_LIMITS = { bytes: 1_000_000, depth: 40, nodes: 20_000 } as const;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(Math.min(parseInt(body.slice(2), 16), 0x10ffff));
    if (body.startsWith('#')) return String.fromCodePoint(Math.min(parseInt(body.slice(1), 10), 0x10ffff));
    return Object.hasOwn(ENTITIES, body) ? (ENTITIES[body] ?? whole) : whole;
  });
}

const local = (name: string): string => name.slice(name.indexOf(':') + 1);

export type XmlResult = { ok: true; root: XmlNode } | { ok: false; error: string };

export function parseXml(input: string): XmlResult {
  if (input.length > XML_LIMITS.bytes) return { ok: false, error: 'That file is too large to read.' };
  if (/<!DOCTYPE|<!ENTITY/i.test(input)) return { ok: false, error: 'That file uses features that are not accepted (a document type or entities).' };
  let i = 0;
  let nodes = 0;
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  const text = input.startsWith(String.fromCharCode(0xfeff)) ? input.slice(1) : input;
  const fail = (error: string): XmlResult => ({ ok: false, error });
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const chunk = text.slice(i, lt === -1 ? text.length : lt);
    const top = stack[stack.length - 1];
    if (chunk.trim() !== '') {
      if (top === undefined) return fail('That file is not XML: text outside the document.');
      top.text += decode(chunk);
    }
    if (lt === -1) break;
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) return fail('That file is not complete: a comment is never closed.');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (top === undefined || end === -1) return fail('That file is not valid XML.');
      top.text += text.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end === -1) return fail('That file is not valid XML.');
      if (!/^<\?xml[\s?]/i.test(text.slice(lt, lt + 8)) && stack.length === 0 && root === null) return fail('That file uses a processing instruction that is not accepted.');
      i = end + 2;
      continue;
    }
    const gt = (() => {
      let quote = '';
      for (let k = lt + 1; k < text.length; k += 1) {
        const ch = text[k] ?? '';
        if (quote !== '') {
          if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '>') return k;
      }
      return -1;
    })();
    if (gt === -1) return fail('That file is not complete: a tag is never closed.');
    const tag = text.slice(lt + 1, gt);
    i = gt + 1;
    if (tag.startsWith('/')) {
      const closing = stack.pop();
      if (closing?.name !== local(tag.slice(1).trim())) return fail('That file is not valid XML: tags do not match.');
      continue;
    }
    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const m = /^([^\s/>]+)([\s\S]*)$/.exec(body.trim());
    if (m === null) return fail('That file is not valid XML.');
    nodes += 1;
    if (nodes > XML_LIMITS.nodes) return fail('That file has too many elements to read.');
    const attrs: Record<string, string> = {};
    for (const a of (m[2] ?? '').matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const key = a[1] ?? '';
      if (!key.startsWith('xmlns')) attrs[local(key)] = decode(a[3] ?? a[4] ?? '');
    }
    const node: XmlNode = { name: local(m[1] ?? ''), attrs, children: [], text: '' };
    if (top === undefined) {
      if (root !== null) return fail('That file is not valid XML: more than one root element.');
      root = node;
    } else top.children.push(node);
    if (!selfClosing) {
      stack.push(node);
      if (stack.length > XML_LIMITS.depth) return fail('That file is nested too deeply to read.');
    }
  }
  if (stack.length > 0 || root === null) return fail('That file is not complete.');
  return { ok: true, root };
}

/** The first descendant reached by following these element names, or undefined. */
export function pick(node: XmlNode | undefined, ...path: string[]): XmlNode | undefined {
  let at = node;
  for (const name of path) {
    at = at?.children.find((c) => c.name === name);
    if (at === undefined) return undefined;
  }
  return at;
}

export const textOf = (node: XmlNode | undefined, ...path: string[]): string => pick(node, ...path)?.text.trim() ?? '';
export const allOf = (node: XmlNode | undefined, name: string): XmlNode[] => node?.children.filter((c) => c.name === name) ?? [];

const ESCAPES: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' };
export const escapeXml = (value: string): string => value.replace(/[<>&"']/g, (c) => ESCAPES[c] ?? c);
