import { describe, expect, it } from 'vitest';
import { escapeXml, parseXml, pick, textOf } from './xml-lite';

describe('the XML reader', () => {
  it('reads elements, attributes, text, CDATA and entities without their namespace prefixes', () => {
    const r = parseXml('<?xml version="1.0"?><a:Root xmlns:a="urn:x" id="7"><!-- c --><a:Name>Tea &amp; <![CDATA[<sugar>]]></a:Name><b:Qty unitCode="KGM">2.5</b:Qty><Empty/></a:Root>');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.root.name).toBe('Root');
    expect(r.root.attrs.id).toBe('7');
    expect(textOf(r.root, 'Name')).toBe('Tea & <sugar>');
    expect(pick(r.root, 'Qty')?.attrs.unitCode).toBe('KGM');
    expect(pick(r.root, 'Empty')?.children).toEqual([]);
  });
  it('refuses a document type, entities, a second root, broken tags and anything too big or deep', () => {
    expect(parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>').ok).toBe(false);
    expect(parseXml('<a/><b/>').ok).toBe(false);
    expect(parseXml('<a><b></a>').ok).toBe(false);
    expect(parseXml('<a>').ok).toBe(false);
    expect(parseXml('just text').ok).toBe(false);
    expect(parseXml(`<a>${'<b>'.repeat(60)}${'</b>'.repeat(60)}</a>`).ok).toBe(false);
    expect(parseXml(`<a>${'x'.repeat(1_100_000)}</a>`).ok).toBe(false);
    expect(parseXml('<?php echo 1; ?><a/>').ok).toBe(false);
  });
  it('escapes what it writes', () => {
    expect(escapeXml(`<a href="x">Tom & 'Jerry'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; &apos;Jerry&apos;&lt;/a&gt;');
  });
});
