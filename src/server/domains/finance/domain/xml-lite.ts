/**
 * A small, safe XML reader for bank statement files. It refuses anything that can be turned against the server (a DOCTYPE,
 * entity declarations, processing instructions that do more than say "xml"), decodes only the five built-in entities and
 * numeric character references, and gives up on files nested deeper than any statement is. Pure.
 */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

export class XmlError extends Error {}

const MAX_DEPTH = 40;
const MAX_NODES = 2_000_000;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return Object.hasOwn(NAMED, body) ? NAMED[body] : whole;
  });
}

/** Local name of a tag: the part after any namespace prefix. */
const local = (qualified: string): string => qualified.slice(qualified.indexOf(':') + 1);

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) attrs[local(m[1])] = decode(m[3] ?? m[4] ?? '');
  return attrs;
}

export function parseXml(source: string): XmlNode {
  const text = source.replace(/^\uFEFF/, '');
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) throw new XmlError('This file declares a document type or entities, which a statement never needs. It was not read.');
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let nodes = 0;
  const tag = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?([\s\S]*?)\?>|<\/([^>\s]+)\s*>|<([^>\s/]+)((?:\s+[^>]*?)?)(\/?)>/g;
  let last = 0;
  for (let m = tag.exec(text); m !== null; m = tag.exec(text)) {
    const between = text.slice(last, m.index);
    const top = stack[stack.length - 1];
    if (between.trim() !== '') top.text += decode(between);
    last = m.index + m[0].length;
    if (m[0].startsWith('<!--')) continue;
    if (m[1] !== undefined) {
      top.text += m[1];
      continue;
    }
    if (m[2] !== undefined) {
      if (!/^xml(\s|$)/i.test(m[2])) throw new XmlError('This file contains an instruction that a statement never needs. It was not read.');
      continue;
    }
    if (m[3] !== undefined) {
      const closing = stack.pop();
      if (closing === undefined || closing === root || closing.name !== local(m[3])) throw new XmlError(`The file is not well formed: </${m[3]}> does not close what was open.`);
      continue;
    }
    nodes += 1;
    if (nodes > MAX_NODES) throw new XmlError('The file has too many parts to be a statement.');
    const node: XmlNode = { name: local(m[4]), attrs: parseAttributes(m[5]), children: [], text: '' };
    top.children.push(node);
    if (m[6] !== '/') {
      stack.push(node);
      if (stack.length > MAX_DEPTH) throw new XmlError('The file is nested far deeper than a statement is.');
    }
  }
  if (text.slice(last).trim() !== '') throw new XmlError('The file has text after its last element.');
  if (stack.length !== 1) throw new XmlError('The file is not well formed: an element was never closed.');
  if (root.children.length !== 1) throw new XmlError('The file must have exactly one top element.');
  return root.children[0];
}

/** Every descendant with this name, in document order. */
export function findAll(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const visit = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name === name) out.push(c);
      visit(c);
    }
  };
  visit(node);
  return out;
}

/** The first child with this name. */
export const child = (node: XmlNode, name: string): XmlNode | undefined => node.children.find((c) => c.name === name);

/** The text at a path of child names (`path(n, 'BookgDt', 'Dt')`), trimmed, or '' when it is not there. */
export function textAt(node: XmlNode, ...names: string[]): string {
  let cur: XmlNode | undefined = node;
  for (const name of names) {
    cur = cur === undefined ? undefined : child(cur, name);
  }
  return cur === undefined ? '' : cur.text.trim();
}
