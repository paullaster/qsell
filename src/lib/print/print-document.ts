/** What a printed part of a screen is made of: pure text building, so the paper sizes and the wrapping can be tested without a browser. */

export type Paper = 'a4' | 'slip';

/** A4 sits inside 14 mm of white on every side; a till slip is 80 mm wide with 3 mm. The page margin is zero so the browser has no room to print its own header and footer (the address, the date, "1 of 2"); the padding does the spacing. */
export function paperCss(paper: Paper): string {
  if (paper === 'slip') return '@page{size:80mm auto;margin:0}html,body{margin:0;background:#fff}body{width:74mm;padding:3mm;box-sizing:content-box;font-size:12px}';
  return '@page{size:A4;margin:0}html,body{margin:0;background:#fff}body{padding:14mm;box-sizing:border-box}';
}

const escapeText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The page that is printed: the part of the screen alone, on white paper with dark ink (the light colours are forced, whatever the
 * reader's screen is using), with the page's own styles carried over so it looks as it does on screen.
 */
export function printDocumentHtml(input: { title: string; paper: Paper; headHtml: string; bodyHtml: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeText(input.title)}</title>${input.headHtml}<style>${paperCss(input.paper)}[hidden],.print\\:hidden{display:none!important}</style></head><body><div class="print-sheet" style="color:#27272a;background:#fff">${input.bodyHtml}</div></body></html>`;
}
