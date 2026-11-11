/* eslint-disable no-console -- a CLI build step: reporting progress is its whole job */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import PDFDocument from 'pdfkit';
import { has, orElse } from '../src/lib/values';
import type {
  DocChapter,
  DocTocItem,
  DocSearchEntry,
  DocVersionManifest,
  DocsManifest,
} from '../src/lib/docs/types';

const ROOT_DIR = process.cwd();
const DOCS_DIR = path.join(ROOT_DIR, 'docs', 'implementor-guide');
const OUTPUT_DIR = path.join(ROOT_DIR, 'src', 'generated', 'docs');
const DOWNLOADS_DIR = path.join(ROOT_DIR, 'public', 'downloads');

// Category mapping based on curriculum stages
const CATEGORY_MAP: Record<string, string> = {
  index: 'Foundations & Roadmap',
  '01-business-overview-and-dashboard': 'Executive & Analytics',
  '02-company-setup-and-storefront': 'Identity & Branding',
  '03-sales-quotes-and-customer-orders': 'Commercial Operations',
  '04-pricing-engine-promotions-and-margins': 'Commercial Operations',
  '05-products-catalog-and-inventory-control': 'Supply Chain & Inventory',
  '06-delivery-logistics-and-field-dispatch': 'Supply Chain & Field',
  '07-users-roles-and-access-governance': 'Governance & Security',
  '08-projects-and-job-costing': 'Commercial Operations',
  '09-vendor-management-procurement-and-payables': 'Supply Chain & Procurement',
  '10-finance-general-ledger-and-accounts-receivable': 'Finance & Accounting',
  '11-banking-cash-and-payment-gateways': 'Finance & Accounting',
  '12-approvals-and-internal-controls': 'Governance & Security',
  '13-settings-branches-numbering-and-kra-etims': 'Fiscal & Administration',
  '14-external-portals-customer-rider-vendor': 'External Ecosystem',
};

function resolveGitSha(): string {
  const deploymentVersion = process.env.DEPLOYMENT_VERSION;
  if (has(deploymentVersion)) {
    const match = /^[a-f\d]{7,40}$/i.exec(deploymentVersion);
    if (match) return match[0].slice(0, 7);
  }
  const gitSha = process.env.GIT_SHA;
  if (has(gitSha)) {
    return gitSha.slice(0, 7);
  }
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'local';
  }
}

function resolvePackageVersion(): string {
  try {
    const pkgRaw = fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw) as { version?: string };
    return orElse(pkg.version, '1.0.0');
  } catch {
    return '1.0.0';
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatInline(markdown: string): string {
  let html = escapeHtml(markdown);

  // Bold + italic
  html = html.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>');
  // Bold
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="doc-inline-code">$1</code>');
  // Links: [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="doc-link">$1</a>');

  return html;
}

/** Strips inline markdown emphasis so PDF text reads as clean print. */
function pdfClean(markdown: string): string {
  return markdown
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2');
}

type PdfBlock =
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'listItem'; readonly marker: string; readonly text: string }
  | { readonly kind: 'table'; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: 'alert'; readonly alertType: string; readonly text: string }
  | { readonly kind: 'code'; readonly text: string };

interface ParsedMarkdown {
  title: string;
  summary: string;
  toc: DocTocItem[];
  html: string;
  wordCount: number;
  blocks: PdfBlock[];
  searchEntries: Omit<DocSearchEntry, 'slug' | 'chapterNumber' | 'category' | 'title'>[];
}

function parseMarkdownToHtml(markdown: string): ParsedMarkdown {
  const lines = markdown.split(/\r?\n/);
  const toc: DocTocItem[] = [];
  const searchEntries: ParsedMarkdown['searchEntries'] = [];
  const htmlParts: string[] = [];
  const blocks: PdfBlock[] = [];

  let title = 'Implementor Manual';
  let summary = '';
  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeBlockLines: string[] = [];
  let inTable = false;
  let tableRows: string[][] = [];
  let currentSectionHeading = 'Introduction';
  let currentSectionId = 'introduction';
  let currentSectionText: string[] = [];
  let inAlert = false;
  let alertType = 'note';
  let alertLines: string[] = [];
  let inList: 'ul' | 'ol' | null = null;

  function flushList() {
    if (inList !== null) {
      htmlParts.push(`</${inList}>`);
      inList = null;
    }
  }

  function flushAlert() {
    if (inAlert) {
      const alertHtml = alertLines.map((l) => `<p>${formatInline(l)}</p>`).join('');
      htmlParts.push(
        `<div class="doc-alert doc-alert-${alertType}" role="region" aria-label="${alertType}">`,
        `<div class="doc-alert-title">${alertType.toUpperCase()}</div>`,
        alertHtml,
        `</div>`,
      );
      blocks.push({ kind: 'alert', alertType, text: alertLines.map(pdfClean).join('\n') });
      inAlert = false;
      alertLines = [];
    }
  }

  function flushTable() {
    if (inTable && tableRows.length > 0) {
      const [header, ...body] = tableRows;
      let tableHtml = '<div class="doc-table-wrapper"><table class="doc-table"><thead><tr>';
      for (const cell of header ?? []) {
        tableHtml += `<th>${formatInline(cell)}</th>`;
      }
      tableHtml += '</tr></thead><tbody>';
      for (const row of body) {
        tableHtml += '<tr>';
        for (const cell of row) {
          tableHtml += `<td>${formatInline(cell)}</td>`;
        }
        tableHtml += '</tr>';
      }
      tableHtml += '</tbody></table></div>';
      htmlParts.push(tableHtml);
      blocks.push({
        kind: 'table',
        rows: tableRows.map((row) => row.map(pdfClean)),
      });
      inTable = false;
      tableRows = [];
    }
  }

  function recordSearchEntry() {
    if (currentSectionText.length > 0) {
      const snippet = currentSectionText.join(' ').replace(/\s+/g, ' ').slice(0, 300);
      searchEntries.push({
        sectionHeading: currentSectionHeading,
        sectionId: currentSectionId,
        snippet,
      });
      currentSectionText = [];
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // Code blocks
    if (trimmed.startsWith('```')) {
      flushList();
      flushAlert();
      flushTable();
      if (inCodeBlock) {
        const rawCode = codeBlockLines.join('\n');
        htmlParts.push(
          `<pre class="doc-code-block"><code class="language-${codeBlockLang}">${escapeHtml(rawCode)}</code></pre>`,
        );
        blocks.push({ kind: 'code', text: rawCode });
        inCodeBlock = false;
        codeBlockLines = [];
        codeBlockLang = '';
      } else {
        inCodeBlock = true;
        codeBlockLang = trimmed.slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    // GitHub alerts: > [!NOTE], > [!IMPORTANT], > [!WARNING], > [!TIP], > [!CAUTION]
    const alertMatch = /^>\s*\[!(NOTE|IMPORTANT|WARNING|TIP|CAUTION)\]/i.exec(trimmed);
    if (alertMatch) {
      flushList();
      flushAlert();
      flushTable();
      inAlert = true;
      alertType = (alertMatch[1] ?? 'NOTE').toLowerCase();
      alertLines = [];
      continue;
    }

    if (inAlert) {
      if (trimmed.startsWith('>')) {
        alertLines.push(trimmed.replace(/^>\s?/, ''));
        continue;
      } else if (trimmed.length === 0) {
        continue;
      } else {
        flushAlert();
      }
    }

    // Markdown tables: | col1 | col2 |
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      flushList();
      flushAlert();
      // Divider line: |---|---|
      if (/^\|(\s*[-:]+\s*\|)+$/.test(trimmed)) {
        continue;
      }
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      if (!inTable) {
        inTable = true;
        tableRows = [cells];
      } else {
        tableRows.push(cells);
      }
      continue;
    } else {
      flushTable();
    }

    // Headings
    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      flushList();
      flushAlert();
      flushTable();
      recordSearchEntry();

      const level = headingMatch[1]?.length ?? 1;
      const rawText = headingMatch[2]?.trim() ?? '';
      const text = rawText.replace(/<[^>]*>/g, '');
      const id = slugify(text);

      if (level === 1) {
        title = text;
      } else {
        toc.push({ id, text, level });
        currentSectionHeading = text;
        currentSectionId = id;
        blocks.push({ kind: 'heading', level, text: pdfClean(rawText) });
      }

      htmlParts.push(
        `<h${level} id="${id}" class="doc-heading doc-h${level}"><a href="#${id}" class="doc-heading-anchor">${formatInline(rawText)}</a></h${level}>`,
      );
      continue;
    }

    // Lists (unordered and ordered)
    const ulMatch = /^[-*]\s+(.+)$/.exec(trimmed);
    if (ulMatch) {
      flushAlert();
      flushTable();
      if (inList !== 'ul') {
        flushList();
        htmlParts.push('<ul class="doc-ul">');
        inList = 'ul';
      }
      const itemText = ulMatch[1] ?? '';
      // Task list item: - [x] or - [ ]
      const taskMatch = /^\[([ xX])\]\s+(.+)$/.exec(itemText);
      if (taskMatch) {
        const checked = (taskMatch[1] ?? '').toLowerCase() === 'x';
        htmlParts.push(
          `<li class="doc-task-item"><input type="checkbox" ${checked ? 'checked' : ''} disabled /> <span>${formatInline(taskMatch[2] ?? '')}</span></li>`,
        );
        blocks.push({
          kind: 'listItem',
          marker: checked ? '[x]' : '[ ]',
          text: pdfClean(taskMatch[2] ?? ''),
        });
      } else {
        htmlParts.push(`<li>${formatInline(itemText)}</li>`);
        blocks.push({ kind: 'listItem', marker: '•', text: pdfClean(itemText) });
      }
      currentSectionText.push(itemText);
      continue;
    }

    const olMatch = /^(\d+)\.\s+(.+)$/.exec(trimmed);
    if (olMatch) {
      flushAlert();
      flushTable();
      if (inList !== 'ol') {
        flushList();
        htmlParts.push('<ol class="doc-ol">');
        inList = 'ol';
      }
      const itemText = olMatch[2] ?? '';
      htmlParts.push(`<li>${formatInline(itemText)}</li>`);
      blocks.push({ kind: 'listItem', marker: `${olMatch[1] ?? ''}.`, text: pdfClean(itemText) });
      currentSectionText.push(itemText);
      continue;
    }

    // Plain lines & paragraphs
    flushList();

    if (trimmed.length === 0) {
      continue;
    }

    // First paragraph after title can be the summary
    if (summary === '' && htmlParts.length > 0 && trimmed.length > 20) {
      summary = trimmed.slice(0, 240);
    }

    htmlParts.push(`<p class="doc-p">${formatInline(trimmed)}</p>`);
    blocks.push({ kind: 'paragraph', text: pdfClean(trimmed) });
    currentSectionText.push(trimmed);
  }

  flushList();
  flushAlert();
  flushTable();
  recordSearchEntry();

  const words = markdown.trim().split(/\s+/).filter(Boolean).length;

  return {
    title,
    summary: summary !== '' ? summary : title,
    toc,
    html: htmlParts.join('\n'),
    wordCount: words,
    blocks,
    searchEntries,
  };
}

interface GeneratedPdf {
  readonly sizeBytes: number;
  readonly pageCount: number;
  readonly sha256: string;
}

async function generateMasterPdf(
  chapters: readonly DocChapter[],
  blocksBySlug: ReadonlyMap<string, readonly PdfBlock[]>,
  versionManifest: Omit<DocVersionManifest, 'pdfSha256' | 'pdfPageCount'>,
  outputPath: string,
): Promise<GeneratedPdf> {
  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      bufferPages: true,
      info: {
        Title: 'OmniCommerce Implementor Blueprint & Commercial Sales Manual',
        Author: 'OmniCommerce Architecture & Enablement Team',
        Subject: `System Documentation ${versionManifest.versionTag}`,
        Keywords: 'OmniCommerce, ERP, Implementor, Sales Enablement, KRA eTIMS, Logistics',
        CreationDate: new Date(versionManifest.buildDate),
      },
    });

    // Maps each page index to the chapter it belongs to, so the running header carries the chapter title.
    const chapterFirstPages: { title: string; firstPage: number }[] = [];

    // Footer band starts at y=800; content must stop above it.
    const CONTENT_BOTTOM = 788;

    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    function ensureSpace(needed: number): void {
      if (doc.y + needed > CONTENT_BOTTOM) {
        // No options: the new page inherits the document's size (A4) and margins.
        // Passing { margin: 40 } alone would reset the page size to Letter.
        doc.addPage();
        doc.y = 50;
      }
    }

    // Overlays (running headers/footers on buffered pages) must never run through the
    // LineWrapper: its page-break check would append a fresh page when the stamp sits
    // below page.maxY. lineBreak: false draws the glyphs directly at x/y.
    function stampText(text: string, x: number, y: number): void {
      doc.text(text, x, y, { lineBreak: false });
    }

    function stampCentered(text: string, y: number): void {
      const textWidth = doc.widthOfString(text);
      stampText(text, 40 + Math.max(0, (515 - textWidth) / 2), y);
    }

    const ALERT_STYLES: Record<string, { bg: string; accent: string }> = {
      note: { bg: '#eff6ff', accent: '#1d4ed8' },
      tip: { bg: '#f0fdf4', accent: '#15803d' },
      important: { bg: '#eef2ff', accent: '#4338ca' },
      warning: { bg: '#fffbeb', accent: '#b45309' },
      caution: { bg: '#fff1f2', accent: '#be123c' },
    };

    function renderAlert(alertType: string, text: string): void {
      const style = ALERT_STYLES[alertType] ?? ALERT_STYLES.note;
      doc.font('Helvetica').fontSize(8.5);
      const textHeight = doc.heightOfString(text, { width: 491 });
      const boxHeight = Math.min(textHeight + 26, 260);
      ensureSpace(boxHeight + 4);
      const y = doc.y + 2;
      doc.roundedRect(40, y, 515, boxHeight, 5).fill(style.bg);
      doc.rect(40, y, 3.5, boxHeight).fill(style.accent);
      doc
        .fillColor(style.accent)
        .font('Helvetica-Bold')
        .fontSize(7.5)
        .text(alertType.toUpperCase(), 52, y + 5, { characterSpacing: 1.5 });
      doc
        .fillColor('#334155')
        .font('Helvetica')
        .fontSize(8.5)
        .text(text, 52, y + 16, { width: 491, height: boxHeight - 20, ellipsis: true, lineGap: 2 });
      doc.y = y + boxHeight + 10;
    }

    function renderCode(text: string): void {
      doc.font('Courier').fontSize(7.5);
      const codeHeight = doc.heightOfString(text, { width: 499 });
      if (codeHeight <= 300 && doc.y + codeHeight + 16 <= CONTENT_BOTTOM) {
        const y = doc.y + 2;
        doc.rect(40, y, 515, codeHeight + 12).fill('#f8fafc');
        doc.rect(40, y, 2.5, codeHeight + 12).fill('#cbd5e1');
        doc
          .fillColor('#0f172a')
          .font('Courier')
          .fontSize(7.5)
          .text(text, 50, y + 6, { width: 499, lineGap: 2 });
        doc.y = y + codeHeight + 20;
      } else {
        doc
          .fillColor('#475569')
          .font('Courier')
          .fontSize(7.5)
          .text(text, 40, doc.y + 2, {
            width: 515,
            lineGap: 2,
          });
        doc.y += 8;
      }
    }

    function renderTable(rows: readonly (readonly string[])[]): void {
      const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 1);
      const columnWidth = 515 / columnCount;
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r] ?? [];
        const isHeader = r === 0;
        doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
        const cellHeights = row.map(
          (cell) => doc.heightOfString(cell, { width: columnWidth - 10 }) + 7,
        );
        const rowHeight = Math.max(14, ...cellHeights);
        ensureSpace(rowHeight);
        const y = doc.y;
        if (isHeader) {
          doc.rect(40, y, 515, rowHeight).fill('#f1f5f9');
        }
        let x = 40;
        for (const cell of row) {
          doc
            .fillColor(isHeader ? '#0f172a' : '#334155')
            .font(isHeader ? 'Helvetica-Bold' : 'Helvetica')
            .fontSize(8)
            .text(cell, x + 5, y + 3, {
              width: columnWidth - 10,
              height: rowHeight - 4,
              ellipsis: true,
              lineGap: 1,
            });
          x += columnWidth;
        }
        doc.moveTo(40, y).lineTo(555, y).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
        doc.y = y + rowHeight;
      }
      doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
      doc.y += 8;
    }

    const HEADING_STYLES: Record<number, { size: number; color: string }> = {
      2: { size: 12.5, color: '#0f172a' },
      3: { size: 10.5, color: '#0284c7' },
      4: { size: 9.5, color: '#334155' },
    };

    function renderBlocks(blocks: readonly PdfBlock[]): void {
      for (const block of blocks) {
        switch (block.kind) {
          case 'heading': {
            const { size, color } = HEADING_STYLES[block.level] ??
              HEADING_STYLES[4] ?? {
                size: 9.5,
                color: '#334155',
              };
            ensureSpace(size * 3);
            doc.y += 8;
            doc.fillColor(color);
            doc.font('Helvetica-Bold').fontSize(size);
            doc.text(block.text, 40, doc.y, { width: 515, lineGap: 2 });
            if (block.level === 2) {
              doc
                .moveTo(40, doc.y + 2)
                .lineTo(555, doc.y + 2)
                .strokeColor('#e2e8f0')
                .lineWidth(0.75)
                .stroke();
              doc.y += 8;
            } else {
              doc.y += 3;
            }
            break;
          }
          case 'paragraph': {
            doc.fillColor('#334155').font('Helvetica').fontSize(9);
            doc.text(block.text, 40, doc.y + 3, { width: 515, lineGap: 2.5 });
            doc.y += 7;
            break;
          }
          case 'listItem': {
            ensureSpace(16);
            doc.font('Helvetica-Bold').fontSize(9);
            const markerWidth = doc.widthOfString(block.marker);
            const y = doc.y + 2;
            stampText(block.marker, 40, y);
            doc
              .fillColor('#334155')
              .font('Helvetica')
              .fontSize(9)
              .text(block.text, 40 + Math.max(markerWidth + 8, 22), y, {
                width: 515 - Math.max(markerWidth + 8, 22),
                lineGap: 2,
              });
            doc.y += 5;
            break;
          }
          case 'table': {
            renderTable(block.rows);
            break;
          }
          case 'alert': {
            renderAlert(block.alertType, block.text);
            break;
          }
          case 'code': {
            renderCode(block.text);
            break;
          }
        }
      }
    }

    // --- COVER PAGE ---
    doc.rect(0, 0, doc.page.width, doc.page.height).fill('#0f172a'); // Slate 900
    doc.fillColor('#38bdf8'); // Sky 400
    doc.fontSize(14).font('Helvetica-Bold').text('OMNICOMMERCE ENTERPRISE PLATFORM', 40, 100, {
      characterSpacing: 2,
    });

    doc.fillColor('#ffffff');
    doc
      .fontSize(28)
      .font('Helvetica-Bold')
      .text('Implementor Blueprint & Commercial Sales Manual', 40, 130, {
        width: 500,
        lineGap: 6,
      });

    doc.fillColor('#94a3b8'); // Slate 400
    doc
      .fontSize(12)
      .font('Helvetica')
      .text('Comprehensive Architecture, Functional Workflows & ROI Playbook', 40, 210);

    // Version Tag Badge Box
    doc.rect(40, 260, 515, 120).fillAndStroke('#1e293b', '#334155');
    doc
      .fillColor('#38bdf8')
      .fontSize(11)
      .font('Helvetica-Bold')
      .text('IMMUTABLE BUILD & VERSION STAMP', 60, 280);

    doc
      .fillColor('#f8fafc')
      .fontSize(12)
      .font('Helvetica-Bold')
      .text(`Version Tag:  ${versionManifest.versionTag}`, 60, 305);
    doc
      .fillColor('#cbd5e1')
      .fontSize(10)
      .font('Helvetica')
      .text(
        `Package Version: ${versionManifest.version}  |  Git Commit: ${versionManifest.gitSha}`,
        60,
        325,
      );
    doc.text(`Build Timestamp: ${versionManifest.buildDate}`, 60, 342);
    doc.text(`Document Hash: ${versionManifest.sourceChecksum.slice(0, 32)}...`, 60, 359);

    // Classification Box
    doc
      .fillColor('#f59e0b')
      .fontSize(10)
      .font('Helvetica-Bold')
      .text('SECURITY CLASSIFICATION: CONFIDENTIAL & PROPRIETARY', 40, 420);
    doc
      .fillColor('#94a3b8')
      .fontSize(9)
      .font('Helvetica')
      .text(
        'For official implementors, enterprise administrators, and authorized commercial sales personnel only. Contains detailed operational formulas, fiscal tax settings, and internal control policies.',
        40,
        438,
        { width: 515, lineGap: 4 },
      );

    doc
      .fillColor('#64748b')
      .fontSize(9)
      .font('Helvetica')
      .text(
        `Compiled automatically at build time. Zero runtime markdown parsing. Verified against OmniCommerce ${versionManifest.versionTag}.`,
        40,
        760,
      );

    // --- TABLE OF CONTENTS PAGE ---
    doc.addPage();
    doc.fillColor('#0f172a').fontSize(20).font('Helvetica-Bold').text('Table of Contents', 40, 50);
    doc.moveTo(40, 78).lineTo(555, 78).strokeColor('#e2e8f0').stroke();

    let tocY = 95;
    for (const chapter of chapters) {
      if (tocY > 740) {
        doc.addPage();
        tocY = 50;
      }

      const chapterPrefix =
        chapter.chapterNumber !== null
          ? `Chapter ${chapter.chapterNumber.toString().padStart(2, '0')}: `
          : 'Master Roadmap: ';
      doc
        .fillColor('#0f172a')
        .fontSize(10)
        .font('Helvetica-Bold')
        .text(chapterPrefix + chapter.title, 40, tocY, {
          width: 420,
        });

      doc
        .fillColor('#64748b')
        .fontSize(9)
        .font('Helvetica')
        .text(chapter.category, 40, tocY + 14);

      doc
        .moveTo(40, tocY + 28)
        .lineTo(555, tocY + 28)
        .strokeColor('#f1f5f9')
        .stroke();
      tocY += 36;
    }

    // --- CHAPTERS CONTENT ---
    for (const chapter of chapters) {
      doc.addPage();
      chapterFirstPages.push({
        title: chapter.title,
        firstPage: doc.bufferedPageRange().count - 1,
      });

      // Chapter header
      const chapHeader =
        chapter.chapterNumber !== null
          ? `CHAPTER ${chapter.chapterNumber.toString().padStart(2, '0')}`
          : 'OVERVIEW';
      doc
        .fillColor('#0284c7')
        .fontSize(11)
        .font('Helvetica-Bold')
        .text(chapHeader, 40, 50, { characterSpacing: 1.5 });
      doc
        .fillColor('#0f172a')
        .fontSize(18)
        .font('Helvetica-Bold')
        .text(chapter.title, 40, 68, { width: 515, lineGap: 4 });

      // Metadata line
      doc
        .fillColor('#64748b')
        .fontSize(9)
        .font('Helvetica')
        .text(
          `Category: ${chapter.category}  |  Reading Time: ~${chapter.readingTimeMinutes} min  |  Words: ${chapter.wordCount.toLocaleString()}`,
          40,
          doc.y + 6,
        );

      doc
        .moveTo(40, doc.y + 8)
        .lineTo(555, doc.y + 8)
        .strokeColor('#cbd5e1')
        .stroke();
      doc.y += 18;

      // Summary
      doc
        .fillColor('#334155')
        .fontSize(10)
        .font('Helvetica-Oblique')
        .text(chapter.summary, 40, doc.y, {
          width: 515,
          lineGap: 4,
        });
      doc.y += 14;

      // Full chapter body, rendered from the build-time parsed blocks
      renderBlocks(blocksBySlug.get(chapter.slug) ?? []);

      // Closing pointer to the interactive console version
      ensureSpace(24);
      doc.y += 6;
      doc
        .fillColor('#475569')
        .fontSize(9)
        .font('Helvetica')
        .text(`Interactive version with live navigation: /admin/docs/${chapter.slug}`, 40, doc.y, {
          width: 515,
        });
    }

    // --- RUNNING HEADERS & FOOTERS (EVERY PAGE) ---
    const totalPages = doc.bufferedPageRange().count;

    const chapterTitleForPage = (pageIndex: number): string => {
      let title = 'Table of Contents';
      for (const entry of chapterFirstPages) {
        if (entry.firstPage <= pageIndex) {
          title = entry.title;
        } else {
          break;
        }
      }
      return title;
    };

    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(i);

      // Skip cover page
      if (i === 0) continue;

      // Running Header with the current chapter title
      doc.fillColor('#94a3b8').fontSize(8).font('Helvetica');
      stampText(`OmniCommerce Implementor & Sales Guide  |  ${chapterTitleForPage(i)}`, 40, 22);
      doc.moveTo(40, 32).lineTo(555, 32).strokeColor('#e2e8f0').stroke();

      // Running Footer with IMMUTABLE VERSION STAMP
      doc.moveTo(40, 800).lineTo(555, 800).strokeColor('#e2e8f0').stroke();
      doc.fillColor('#64748b').fontSize(8).font('Helvetica');
      stampCentered(
        `CONFIDENTIAL — VERSION: ${versionManifest.versionTag} — PAGE ${i + 1} OF ${totalPages}`,
        808,
      );
    }

    doc.end();

    stream.on('finish', () => {
      const bytes = fs.readFileSync(outputPath);
      resolve({
        sizeBytes: bytes.length,
        pageCount: totalPages,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      });
    });

    stream.on('error', reject);
  });
}

async function main() {
  console.log('[docs-build] Starting build-time documentation pre-rendering and PDF generation...');

  if (!fs.existsSync(DOCS_DIR)) {
    throw new Error(`[docs-build] Implementor documentation directory not found: ${DOCS_DIR}`);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

  const version = resolvePackageVersion();
  const gitSha = resolveGitSha();
  const versionTag = `v${version}-${gitSha}`;
  const buildDate = new Date().toISOString();

  // Read all markdown files in order
  const filenames = fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort();

  // Ensure README.md is first
  const sortedFiles = [
    ...filenames.filter((f) => f === 'README.md'),
    ...filenames.filter((f) => f !== 'README.md'),
  ];

  const chapters: DocChapter[] = [];
  const searchIndex: DocSearchEntry[] = [];
  const blocksBySlug = new Map<string, readonly PdfBlock[]>();
  const hash = crypto.createHash('sha256');

  for (const filename of sortedFiles) {
    const filePath = path.join(DOCS_DIR, filename);
    const rawContent = fs.readFileSync(filePath, 'utf8');
    hash.update(rawContent);

    const isReadme = filename === 'README.md';
    const slug = isReadme ? 'index' : filename.replace(/\.md$/, '');
    const chapterNumMatch = /^(\d+)-/.exec(filename);
    const chapterNumber = chapterNumMatch ? parseInt(chapterNumMatch[1] ?? '0', 10) : null;

    const parsed = parseMarkdownToHtml(rawContent);
    const category = CATEGORY_MAP[slug] ?? 'General';
    const readingTimeMinutes = Math.max(1, Math.ceil(parsed.wordCount / 200));

    const chapter: DocChapter = {
      slug,
      filename,
      chapterNumber,
      title: parsed.title,
      category,
      summary: parsed.summary,
      readingTimeMinutes,
      wordCount: parsed.wordCount,
      toc: parsed.toc,
      htmlContent: parsed.html,
    };

    chapters.push(chapter);
    blocksBySlug.set(slug, parsed.blocks);

    for (const entry of parsed.searchEntries) {
      searchIndex.push({
        slug,
        chapterNumber,
        title: parsed.title,
        category,
        sectionHeading: entry.sectionHeading,
        sectionId: entry.sectionId,
        snippet: entry.snippet,
      });
    }
  }

  const sourceChecksum = hash.digest('hex');

  // Generate Master Version-Tagged PDF
  const pdfFilename = `omnicommerce-implementor-guide-${versionTag}.pdf`;
  const pdfPath = path.join(DOWNLOADS_DIR, pdfFilename);
  const latestPdfPath = path.join(DOWNLOADS_DIR, 'omnicommerce-implementor-guide-latest.pdf');

  console.log(`[docs-build] Compiling version-tagged master PDF: ${pdfFilename}...`);
  const initialManifest = {
    version,
    gitSha,
    versionTag,
    buildDate,
    sourceChecksum,
    pdfFilename,
    pdfUrl: `/downloads/${pdfFilename}`,
    pdfSizeBytes: 0,
    chaptersCount: chapters.length,
  };

  const pdf = await generateMasterPdf(chapters, blocksBySlug, initialManifest, pdfPath);
  fs.copyFileSync(pdfPath, latestPdfPath);

  const versionManifest: DocVersionManifest = {
    ...initialManifest,
    pdfSizeBytes: pdf.sizeBytes,
    pdfSha256: pdf.sha256,
    pdfPageCount: pdf.pageCount,
  };

  // Write version manifest JSON to public downloads
  fs.writeFileSync(
    path.join(DOWNLOADS_DIR, 'version-manifest.json'),
    JSON.stringify(versionManifest, null, 2),
    'utf8',
  );

  // Write pre-rendered docs manifest to src/generated/docs/docs-manifest.json
  const docsManifest: DocsManifest = {
    versionManifest,
    chapters,
    searchIndex,
  };

  const manifestJsonPath = path.join(OUTPUT_DIR, 'docs-manifest.json');
  fs.writeFileSync(manifestJsonPath, JSON.stringify(docsManifest, null, 2), 'utf8');

  // Write typed TS wrapper index.ts
  const tsWrapper = `// Auto-generated by scripts/build-docs.ts at build time. Do not edit manually.
import manifestJson from './docs-manifest.json';
import type {
  DocsManifest,
  DocChapter,
  DocSearchEntry,
  DocVersionManifest,
} from '../../lib/docs/types';

export const DOCS_MANIFEST: DocsManifest = manifestJson;

export function getDocsManifest(): DocsManifest {
  return DOCS_MANIFEST;
}

export function getVersionManifest(): DocVersionManifest {
  return DOCS_MANIFEST.versionManifest;
}

export function getAllChapters(): readonly DocChapter[] {
  return DOCS_MANIFEST.chapters;
}

export function getChapterBySlug(slug: string): DocChapter | undefined {
  return DOCS_MANIFEST.chapters.find((c) => c.slug === slug);
}

export function getSearchIndex(): readonly DocSearchEntry[] {
  return DOCS_MANIFEST.searchIndex;
}
`;

  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.ts'), tsWrapper, 'utf8');

  console.log(`[docs-build] SUCCESS:`);
  console.log(`  - Version Tag: ${versionTag}`);
  console.log(`  - Chapters: ${chapters.length}`);
  console.log(`  - Search index entries: ${searchIndex.length}`);
  console.log(
    `  - PDF file: ${pdfFilename} (${(pdf.sizeBytes / 1024).toFixed(1)} KB, ${pdf.pageCount} pages)`,
  );
  console.log(`  - Output: ${manifestJsonPath}`);
}

main().catch((err: unknown) => {
  console.error('[docs-build] FATAL ERROR:', err);
  process.exit(1);
});
