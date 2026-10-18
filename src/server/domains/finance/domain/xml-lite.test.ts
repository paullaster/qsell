import { describe, expect, it } from 'vitest';
import { XmlError, child, findAll, parseXml, textAt } from './xml-lite';

describe('reading XML safely', () => {
  it('reads elements, attributes, text, CDATA and comments, ignoring namespace prefixes', () => {
    const root = parseXml(`<?xml version="1.0" encoding="UTF-8"?>
      <a:Doc xmlns:a="urn:x"><!-- note --><a:Amt Ccy="KES">12.50</a:Amt><a:Txt><![CDATA[1 < 2 & 3]]></a:Txt><a:Empty/></a:Doc>`);
    expect(root.name).toBe('Doc');
    expect(child(root, 'Amt')?.attrs).toEqual({ Ccy: 'KES' });
    expect(textAt(root, 'Amt')).toBe('12.50');
    expect(textAt(root, 'Txt')).toBe('1 < 2 & 3');
    expect(child(root, 'Empty')?.children).toEqual([]);
    expect(textAt(root, 'Missing', 'Deeper')).toBe('');
  });

  it('decodes the five built-in entities and numeric references, and nothing else', () => {
    const root = parseXml('<R><T>Tom &amp; Jerry &lt;3 &#65;&#x42; &unknown;</T></R>');
    expect(textAt(root, 'T')).toBe('Tom & Jerry <3 AB &unknown;');
  });

  it('finds every descendant of a name in document order', () => {
    const root = parseXml('<R><S><N>1</N></S><S><N>2</N><X><N>3</N></X></S></R>');
    expect(findAll(root, 'N').map((n) => n.text)).toEqual(['1', '2', '3']);
  });

  it('refuses what can be turned against the server', () => {
    expect(() => parseXml('<!DOCTYPE r [<!ENTITY x "boom">]><r>&x;</r>')).toThrow(XmlError);
    expect(() => parseXml('<!DOCTYPE r><r/>')).toThrow(XmlError);
    expect(() => parseXml('<?xml-stylesheet href="x"?><r/>')).toThrow(XmlError);
    expect(() => parseXml('<r><!ENTITY x "1"></r>')).toThrow(XmlError);
  });

  it('refuses files that are not well formed, or absurdly deep', () => {
    expect(() => parseXml('<a><b></a>')).toThrow(/does not close/);
    expect(() => parseXml('<a><b>')).toThrow(/never closed/);
    expect(() => parseXml('<a/><b/>')).toThrow(/exactly one/);
    expect(() => parseXml('<a/>junk')).toThrow(/after its last/);
    expect(() => parseXml('')).toThrow(XmlError);
    expect(() => parseXml('<a>'.repeat(60) + '</a>'.repeat(60))).toThrow(/deeper/);
  });
});
