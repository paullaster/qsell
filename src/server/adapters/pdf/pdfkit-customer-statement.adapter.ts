import PDFDocument from 'pdfkit';
import type { StatementDownload } from '@/lib/customer-statement';
import type { CompanyProfile } from '@/server/ports/communications';

const INK = '#111827';
const MUTED = '#6B7280';
const LINE = '#E5E7EB';
const ACCENT = '#4F46E5';

const text = (value: string | null | undefined): string =>
  value === null || value === undefined || value.trim() === '' ? '—' : value;
const amount = (value: string): string => (Number(value) === 0 ? '—' : value);

export function renderCustomerStatementPdf(
  statement: StatementDownload,
  company: CompanyProfile,
  generatedOn: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      bufferPages: true,
      info: {
        Title: `Customer statement ${statement.customerNumber}`,
        Author: company.tradingName === '' ? company.legalName : company.tradingName,
        Subject: `Statement for ${statement.customerName}`,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width;
    const H = doc.page.height;
    const M = 36;
    const CW = W - M * 2;
    const companyName = company.tradingName === '' ? company.legalName : company.tradingName;
    const accent = company.accentColor === '' ? ACCENT : company.accentColor;
    const primary = company.primaryColor === '' ? INK : company.primaryColor;
    const tel =
      company.tel === null || company.tel === undefined || company.tel === ''
        ? company.phone
        : company.tel;
    const address = [
      company.streetAddress,
      [company.city, company.countyOrState, company.postalCode]
        .filter((value) => value !== '')
        .join(', '),
      company.country,
      `Tel: ${tel}`,
      `Email: ${company.email}`,
    ]
      .filter((value) => value !== '')
      .join(' · ');
    const columns = [
      { label: 'Date', width: 58 },
      { label: 'Document', width: 102 },
      { label: 'Description', width: 150 },
      { label: 'Due', width: 55 },
      { label: 'Debit', width: 55 },
      { label: 'Credit', width: 55 },
      { label: 'Balance', width: CW - 475 },
    ];

    const pageHeader = () => {
      doc.rect(0, 0, W, 6).fill(accent);
      doc.fillColor(primary).font('Helvetica-Bold').fontSize(14);
      doc.text(companyName, M, 22, { width: CW * 0.6, lineBreak: false, ellipsis: true });
      doc.fillColor(MUTED).font('Helvetica').fontSize(7.5);
      doc.text(address, M, 40, { width: CW * 0.6 });
      doc.fillColor(accent).font('Helvetica-Bold').fontSize(16);
      doc.text('CUSTOMER STATEMENT', M + CW * 0.62, 22, {
        width: CW * 0.38,
        align: 'right',
        lineBreak: false,
      });
      doc.fillColor(INK).fontSize(9);
      doc.text(statement.customerName, M + CW * 0.62, 44, {
        width: CW * 0.38,
        align: 'right',
        lineBreak: false,
        ellipsis: true,
      });
      doc.fillColor(MUTED).font('Helvetica').fontSize(7.5);
      doc.text(
        `${text(statement.customerNumber)} · ${
          statement.from === '' && statement.to === ''
            ? 'All dates'
            : `${text(statement.from)} to ${text(statement.to)}`
        }`,
        M + CW * 0.62,
        56,
        { width: CW * 0.38, align: 'right', lineBreak: false, ellipsis: true },
      );
      doc
        .moveTo(M, 68)
        .lineTo(M + CW, 68)
        .strokeColor(LINE)
        .stroke();
      doc.y = 78;
    };

    const tableHeader = () => {
      doc.rect(M, doc.y, CW, 16).fill('#F3F4F6');
      doc.y += 4;
      let x = M;
      for (const column of columns) {
        doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7);
        doc.text(column.label, x + 3, doc.y, {
          width: column.width - 6,
          lineBreak: false,
          ellipsis: true,
        });
        x += column.width;
      }
      doc.y += 14;
      doc
        .moveTo(M, doc.y)
        .lineTo(M + CW, doc.y)
        .strokeColor(LINE)
        .stroke();
      doc.y += 4;
    };

    const summary = () => {
      const boxes = [
        ['Opening balance', statement.openingBalance],
        ['Debits this period', statement.totalDebit],
        ['Credits this period', statement.totalCredit],
        ['Closing balance', statement.closingBalance],
      ];
      const width = CW / boxes.length;
      boxes.forEach(([label, value], index) => {
        const x = M + index * width;
        doc.rect(x, doc.y, width - 6, 32).fill('#F9FAFB');
        doc.fillColor(MUTED).font('Helvetica').fontSize(7);
        doc.text(label, x + 6, doc.y + 5, { width: width - 18, lineBreak: false });
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(11);
        doc.text(value, x + 6, doc.y + 16, {
          width: width - 18,
          lineBreak: false,
          ellipsis: true,
        });
      });
      doc.y += 40;
    };

    pageHeader();
    summary();
    tableHeader();

    statement.lines.forEach((line, index) => {
      if (doc.y > H - 58) {
        doc.addPage();
        pageHeader();
        tableHeader();
      }
      if (index % 2 === 1) doc.rect(M, doc.y - 2, CW, 15).fill('#FAFAFA');
      const y = doc.y;
      let x = M;
      const values = [
        text(line.date),
        text(line.document),
        text(line.description),
        text(line.dueDate),
        amount(line.debit),
        amount(line.credit),
        line.balance,
      ];
      columns.forEach((column, columnIndex) => {
        const align: 'left' | 'right' | 'center' = columnIndex >= 4 ? 'right' : 'left';
        doc.fillColor(INK).font('Helvetica').fontSize(7.5);
        doc.text(values[columnIndex] ?? '', x + 3, y, {
          width: column.width - 6,
          align,
          lineBreak: false,
          ellipsis: true,
        });
        x += column.width;
      });
      doc.y = y + 15;
      doc
        .moveTo(M, doc.y)
        .lineTo(M + CW, doc.y)
        .strokeColor(LINE)
        .stroke();
      doc.y += 3;
    });

    const pages = doc.bufferedPageRange();
    for (let page = 0; page < pages.count; page += 1) {
      doc.switchToPage(page);
      doc.fillColor(MUTED).font('Helvetica').fontSize(7);
      doc.text(`Generated ${generatedOn} · Page ${page + 1} of ${pages.count}`, M, H - 28, {
        width: CW,
        align: 'center',
        lineBreak: false,
      });
    }
    doc.end();
  });
}
