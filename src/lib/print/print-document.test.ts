import { describe, expect, it } from 'vitest';
import { paperCss, printDocumentHtml } from './print-document';

describe('what is printed from a part of a screen', () => {
  it('has no page margin on either paper, so the browser has no room for its own header and footer', () => {
    expect(paperCss('a4')).toContain('@page{size:A4;margin:0}');
    expect(paperCss('slip')).toContain('@page{size:80mm auto;margin:0}');
    expect(paperCss('slip')).toContain('width:74mm');
  });

  it('puts only the given part on white paper with dark ink, with the page styles carried over', () => {
    const html = printDocumentHtml({ title: 'Slip <1>', paper: 'a4', headHtml: '<style>.x{color:red}</style>', bodyHtml: '<section id="s">Total 100</section>' });
    expect(html).toContain('<title>Slip &lt;1&gt;</title>');
    expect(html).toContain('<style>.x{color:red}</style>');
    expect(html).toContain('class="print-sheet"');
    expect(html).toContain('<section id="s">Total 100</section>');
    expect(html.match(/<body>/g)?.length).toBe(1);
  });
});
