import PDFDocument from 'pdfkit';
import {
  STATEMENT_NOTES,
  STATEMENT_WORDS as W,
  statementAgeLabel,
  statementDate,
  statementPeriodText,
  type StatementDownload,
} from '@/lib/customer-statement';
import type { CompanyProfile } from '@/server/ports/communications';

const INK = '#111827';
const MUTED = '#4B5563';
const LINE = '#D1D5DB';
const ACCENT = '#4F46E5';
const BAND = '#F3F4F6';

const text = (value: string | null | undefined): string => (value === null || value === undefined || value.trim() === '' ? '' : value);
const amount = (value: string): string => (Number(value) === 0 ? '' : value);
const part = (value: string | null | undefined): string[] => (value === null || value === undefined || value.trim() === '' ? [] : [value.trim()]);

/**
 * The statement of account as a lender or bank reads it: who issued it and to whom, the period and currency, the account summary
 * (brought forward + debits - credits = closing balance), the open invoices aged, then every transaction with its running balance,
 * ending on the closing balance due. Amounts are printed as they stand in the ledger; nothing is rounded or re-worded here.
 */
export function renderCustomerStatementPdf(statement: StatementDownload, company: CompanyProfile, generatedOn: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const companyName = company.legalName === '' ? company.tradingName : company.legalName;
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      bufferPages: true,
      info: {
        Title: `${W.title} ${statement.customerNumber}`,
        Author: companyName,
        Subject: `${W.title} for ${statement.customerName}, ${statementPeriodText(statement.from, statement.to)}`,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const PW = doc.page.width;
    const H = doc.page.height;
    const M = 36;
    const CW = PW - M * 2;
    const accent = company.accentColor === '' ? ACCENT : company.accentColor;
    const primary = company.primaryColor === '' ? INK : company.primaryColor;
    const tel = company.tel === null || company.tel === undefined || company.tel === '' ? company.phone : company.tel;
    const companyLines = [
      [company.streetAddress, [company.city, company.countyOrState, company.postalCode].filter((v) => v !== '').join(', '), company.country].filter((v) => v !== '').join(', '),
      [tel === '' ? '' : `Tel: ${tel}`, company.email === '' ? '' : `Email: ${company.email}`].filter((v) => v !== '').join('  ·  '),
      [company.kraPin === '' ? '' : `KRA PIN: ${company.kraPin}`, ...part(company.vatNumber).map((v) => `VAT no.: ${v}`), ...part(company.registrationNumber).map((v) => `Reg. no.: ${v}`)].filter((v) => v !== '').join('  ·  '),
    ].filter((v) => v !== '');
    const balanceWidth = CW - 466;
    const columns = [
      { label: 'Date', width: 56, right: false },
      { label: 'Reference', width: 100, right: false },
      { label: 'Details', width: 142, right: false },
      { label: 'Due date', width: 56, right: false },
      { label: 'Debit', width: 56, right: true },
      { label: 'Credit', width: 56, right: true },
      { label: 'Balance', width: balanceWidth, right: true },
    ];
    const currency = statement.currency;

    const rule = (y: number, color = LINE, width = 0.5) => {
      doc.lineWidth(width).moveTo(M, y).lineTo(M + CW, y).strokeColor(color).stroke();
    };

    const firstPageHeader = () => {
      doc.rect(0, 0, PW, 6).fill(accent);
      doc.fillColor(primary).font('Helvetica-Bold').fontSize(14);
      doc.text(companyName, M, 22, { width: CW * 0.58, lineBreak: false, ellipsis: true });
      doc.fillColor(MUTED).font('Helvetica').fontSize(7.5);
      let y = 40;
      for (const line of companyLines) {
        doc.text(line, M, y, { width: CW * 0.6 });
        y += 10;
      }
      doc.fillColor(accent).font('Helvetica-Bold').fontSize(17);
      doc.text(W.title.toUpperCase(), M + CW * 0.5, 22, { width: CW * 0.5, align: 'right', lineBreak: false });
      doc.fillColor(MUTED).font('Helvetica').fontSize(8);
      doc.text(statementPeriodText(statement.from, statement.to), M + CW * 0.5, 46, { width: CW * 0.5, align: 'right', lineBreak: false });
      doc.y = Math.max(y, 62) + 8;
      rule(doc.y);
      doc.y += 10;
    };

    const runningHeader = () => {
      doc.rect(0, 0, PW, 6).fill(accent);
      doc.fillColor(primary).font('Helvetica-Bold').fontSize(10);
      doc.text(companyName, M, 18, { width: CW * 0.4, lineBreak: false, ellipsis: true });
      doc.fillColor(MUTED).font('Helvetica').fontSize(8);
      doc.text(`${W.title}  ·  ${statement.customerName}  ·  ${W.accountNumber} ${statement.customerNumber}`, M + CW * 0.42, 20, { width: CW * 0.58, align: 'right', lineBreak: false, ellipsis: true });
      rule(36);
      doc.y = 46;
    };

    /** Two blocks side by side: the account holder and the statement details, as label/value pairs. */
    const parties = () => {
      const top = doc.y;
      const half = CW / 2 - 8;
      const block = (x: number, heading: string, pairs: readonly (readonly [string, string])[]): number => {
        doc.fillColor(accent).font('Helvetica-Bold').fontSize(8).text(heading.toUpperCase(), x, top, { width: half, lineBreak: false });
        let y = top + 13;
        for (const [label, value] of pairs) {
          if (value === '') continue;
          doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(label, x, y, { width: 92, lineBreak: false });
          doc.fillColor(INK).font('Helvetica').fontSize(8.5);
          const h = doc.heightOfString(value, { width: half - 96 });
          doc.text(value, x + 96, y, { width: half - 96 });
          y += Math.max(12, h + 2);
        }
        return y;
      };
      const left = block(M, W.accountHolder, [
        ['Name', statement.customerName],
        [W.accountNumber, statement.customerNumber],
        ['KRA PIN', statement.customerKraPin],
        ['Address', statement.customerAddress.join(', ')],
      ]);
      const right = block(M + CW / 2 + 8, W.statementDetails, [
        [W.statementDate, statementDate(statement.statementDate)],
        [W.period, statementPeriodText(statement.from, statement.to)],
        [W.currency, currency],
        [W.paymentTerms, statement.paymentTerms],
        [W.creditLimit, statement.creditLimit === '' ? '' : `${currency} ${statement.creditLimit}`.trim()],
      ]);
      doc.y = Math.max(left, right) + 8;
    };

    const sectionHeading = (heading: string) => {
      doc.fillColor(accent).font('Helvetica-Bold').fontSize(8).text(heading.toUpperCase(), M, doc.y, { width: CW, lineBreak: false });
      doc.y += 12;
    };

    /** Brought forward, add debits, less credits, closing balance due: the sum a reader can check with a calculator. */
    const summary = () => {
      sectionHeading(W.summary);
      const rows: readonly (readonly [string, string])[] = [
        [W.broughtForward, statement.openingBalance],
        [`Add: ${W.debits.toLowerCase()}`, statement.totalDebit],
        [`Less: ${W.credits.toLowerCase()}`, statement.totalCredit],
      ];
      for (const [label, value] of rows) {
        const y = doc.y;
        doc.fillColor(INK).font('Helvetica').fontSize(8.5).text(label, M + 4, y, { width: CW - 130, lineBreak: false });
        doc.text(`${currency} ${value}`.trim(), M + CW - 124, y, { width: 120, align: 'right', lineBreak: false });
        doc.y = y + 13;
        rule(doc.y);
        doc.y += 4;
      }
      const y = doc.y;
      doc.rect(M, y - 1, CW, 18).fill(BAND);
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5).text(W.closingDue, M + 4, y + 3, { width: CW - 130, lineBreak: false });
      doc.text(`${currency} ${statement.closingBalance}`.trim(), M + CW - 124, y + 3, { width: 120, align: 'right', lineBreak: false });
      doc.y = y + 28;
    };

    const ageing = () => {
      if (statement.ageing.length === 0) return;
      sectionHeading(`${W.aged} as at ${statementDate(statement.statementDate)}`);
      const cell = CW / statement.ageing.length;
      const top = doc.y;
      doc.rect(M, top, CW, 14).fill(BAND);
      statement.ageing.forEach((bucket, i) => {
        doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7);
        doc.text(statementAgeLabel(bucket.label), M + i * cell + 3, top + 4, { width: cell - 6, align: 'right', lineBreak: false, ellipsis: true });
        doc.fillColor(INK).font('Helvetica').fontSize(8.5);
        doc.text(bucket.amount, M + i * cell + 3, top + 19, { width: cell - 6, align: 'right', lineBreak: false, ellipsis: true });
      });
      doc.y = top + 36;
      rule(doc.y - 4);
      doc.y += 6;
    };

    const tableHeader = () => {
      const top = doc.y;
      doc.rect(M, top, CW, 16).fill(BAND);
      let x = M;
      for (const column of columns) {
        doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7);
        doc.text(column.label, x + 3, top + 5, { width: column.width - 6, align: column.right ? 'right' : 'left', lineBreak: false, ellipsis: true });
        x += column.width;
      }
      doc.y = top + 18;
      rule(doc.y);
      doc.y += 4;
    };

    const row = (values: readonly string[], bold: boolean, shade: boolean) => {
      const y = doc.y;
      if (shade) doc.rect(M, y - 2, CW, 15).fill('#FAFAFA');
      let x = M;
      columns.forEach((column, i) => {
        doc.fillColor(INK).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5);
        doc.text(values[i] ?? '', x + 3, y, { width: column.width - 6, align: column.right ? 'right' : 'left', lineBreak: false, ellipsis: true });
        x += column.width;
      });
      doc.y = y + 15;
      rule(doc.y);
      doc.y += 3;
    };

    /** Starts a new page when what comes next would not fit; says whether it did. */
    const room = (needed: number): boolean => {
      if (doc.y + needed <= H - 60) return false;
      doc.addPage();
      runningHeader();
      return true;
    };

    firstPageHeader();
    parties();
    summary();
    ageing();
    sectionHeading(W.transactions);
    tableHeader();
    row(['', '', W.broughtForward, '', '', '', statement.openingBalance], true, false);

    if (statement.lines.length === 0) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(W.empty, M + 3, doc.y + 2, { width: CW });
      doc.y += 20;
    }
    statement.lines.forEach((line, index) => {
      if (room(20)) tableHeader();
      row([statementDate(line.date), text(line.document), text(line.description), statementDate(line.dueDate), amount(line.debit), amount(line.credit), line.balance], false, index % 2 === 1);
    });

    if (room(40)) tableHeader();
    row(['', '', W.closingDue, '', statement.totalDebit, statement.totalCredit, statement.closingBalance], true, false);
    doc.lineWidth(1.5).moveTo(M + CW - balanceWidth, doc.y - 2).lineTo(M + CW, doc.y - 2).strokeColor(INK).stroke();
    doc.y += 8;

    // Where to pay, and what the columns mean.
    room(90);
    const bank = { name: part(company.bankName), holder: part(company.bankAccountName), number: part(company.bankAccountNumber), branch: part(company.bankBranch) };
    if (bank.name.length + bank.number.length > 0) {
      sectionHeading('Payment details');
      const bits = [
        ...bank.name.map((v) => `Bank: ${v}`),
        ...bank.holder.map((v) => `Account name: ${v}`),
        ...bank.number.map((v) => `Account no.: ${v}`),
        ...bank.branch.map((v) => `Branch: ${v}`),
      ];
      doc.fillColor(INK).font('Helvetica').fontSize(8).text(bits.join('  ·  '), M + 3, doc.y, { width: CW - 6 });
      doc.y += 4;
      doc.fillColor(MUTED).text(`Please quote ${statement.customerNumber} as the payment reference.`, M + 3, doc.y, { width: CW - 6 });
      doc.y += 14;
    }
    sectionHeading('Notes');
    for (const note of STATEMENT_NOTES) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(7.5);
      const h = doc.heightOfString(`•  ${note}`, { width: CW - 6 });
      doc.text(`•  ${note}`, M + 3, doc.y, { width: CW - 6 });
      doc.y += h + 3;
    }

    const pages = doc.bufferedPageRange();
    for (let page = 0; page < pages.count; page += 1) {
      doc.switchToPage(page);
      doc.fillColor(MUTED).font('Helvetica').fontSize(7);
      doc.text(`${W.title}  ·  ${statement.customerName}  ·  Generated ${statementDate(generatedOn.slice(0, 10))}  ·  Page ${String(page + 1)} of ${String(pages.count)}`, M, H - 28, {
        width: CW,
        align: 'center',
        lineBreak: false,
      });
    }
    doc.end();
  });
}
