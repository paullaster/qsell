'use client';

import { printDocumentHtml, type Paper } from './print-document';

/**
 * Prints one part of the screen on its own: it is copied, with the page's styles, into a hidden frame and that is printed, so nothing
 * around it (the menus, forms and buttons) can come out on paper. Resolves when the print dialog has been asked for; false when the
 * part could not be found.
 */
export async function printElement(id: string, options: { title: string; paper: Paper }): Promise<boolean> {
  const source = document.getElementById(id);
  if (source === null) return false;
  const headHtml = [...document.head.querySelectorAll('link[rel="stylesheet"], style')].map((node) => node.outerHTML).join('');
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.dataset.printFrame = id;
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
  frame.srcdoc = printDocumentHtml({ title: options.title, paper: options.paper, headHtml, bodyHtml: source.outerHTML });
  const loaded = new Promise<void>((resolve) => {
    frame.onload = () => resolve();
  });
  document.body.append(frame);
  await loaded;
  const inside = frame.contentDocument;
  // The styles may still be arriving; wait for them (briefly) so the paper is not unstyled.
  if (inside !== null) {
    const sheets = [...inside.querySelectorAll('link[rel="stylesheet"]')].filter((l) => (l as HTMLLinkElement).sheet === null);
    await Promise.race([Promise.all(sheets.map((l) => new Promise<void>((resolve) => { l.addEventListener('load', () => resolve()); l.addEventListener('error', () => resolve()); }))), new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
  }
  frame.contentWindow?.focus();
  frame.contentWindow?.print();
  setTimeout(() => frame.remove(), 60_000);
  return true;
}
