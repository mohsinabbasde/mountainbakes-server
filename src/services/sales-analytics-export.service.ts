import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { format } from 'date-fns';
import type { SalesAnalytics } from '../shared';

/**
 * Export the Daily Sales card — Excel, PDF or CSV.
 *
 * Not `genericExcel`/`genericPDF` (production-export.service.ts): those take one
 * flat table, and this payload is four tables of different widths — a summary,
 * a day series, a payment mix and a product ranking. Flattening them into one
 * grid means a header row that describes only the first section and three
 * sections sitting under column names that do not apply to them.
 *
 * `buildSections` is the single description of what the report contains; all
 * three formats render it. Adding a figure in one format and not the others is
 * how an exported total stops matching the screen it was exported from.
 *
 * The caller is responsible for the payload being one the requesting user may
 * see — `getSalesAnalytics` is given a server-resolved branch scope, and this
 * only formats what it is handed.
 */

type Cell = string | number;

interface Section {
  title: string;
  headers: string[];
  rows: Cell[][];
  /** 1-based column indexes holding money, for number formatting in Excel. */
  moneyColumns: number[];
}

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Cash',
  easypaisa: 'Easypaisa',
  foodpanda: 'Foodpanda',
  bank_account: 'Bank Account',
  staff: 'Staff (unpaid)',
  card: 'Card',
  online: 'Online',
};

const paymentLabel = (method: string) => PAYMENT_LABELS[method] ?? method;

/** Money as a NUMBER, never a formatted string — a sheet's whole point is that its columns sum. */
const money = (n: number) => Math.round(n * 100) / 100;

function comparisonLine(a: SalesAnalytics): string {
  if (!a.comparison) return 'Not compared';
  const c = a.comparison;
  if (c.changePct === null) {
    return c.sales === 0
      ? `No sales in the previous period (${c.from} to ${c.to})`
      : `${c.from} to ${c.to}`;
  }
  const arrow = c.direction === 'up' ? 'Up' : c.direction === 'down' ? 'Down' : 'Stable';
  return `${arrow} ${Math.abs(c.changePct)}% vs ${c.from} to ${c.to}`;
}

export function buildSections(a: SalesAnalytics): Section[] {
  const sections: Section[] = [
    {
      title: 'Summary',
      headers: ['Figure', 'Value'],
      rows: [
        ['Branch', a.branchName ?? 'All Branches'],
        ['Period', a.from === a.effectiveTo ? a.from : `${a.from} to ${a.effectiveTo}`],
        ['Total Sales', money(a.totalSales)],
        ["Today's Sales", money(a.todaySales)],
        ['Average Daily Sales', money(a.averageDailySales)],
        ['Highest Sales Day', a.highestDay ? `${a.highestDay.date}` : '—'],
        ['Highest Day Sales', a.highestDay ? money(a.highestDay.sales) : 0],
        ['Lowest Sales Day', a.lowestDay ? `${a.lowestDay.date}` : '—'],
        ['Lowest Day Sales', a.lowestDay ? money(a.lowestDay.sales) : 0],
        ['Transactions', a.totalTransactions],
        ['vs Previous Period', comparisonLine(a)],
      ],
      moneyColumns: [2],
    },
    {
      title: 'Daily Sales',
      headers: ['Business Date', 'Sales (Rs.)', 'Transactions'],
      rows: a.daily.map((d) => [d.date, money(d.sales), d.transactions]),
      moneyColumns: [2],
    },
    {
      title: 'Payment Methods',
      headers: ['Method', 'Total (Rs.)', 'Transactions'],
      rows: a.paymentMethods.map((p) => [paymentLabel(p.method), money(p.total), p.count]),
      moneyColumns: [2],
    },
    {
      title: `Top ${a.topProducts.length} Products`,
      headers: ['Product', 'Category', 'Qty Sold', 'Sales (Rs.)'],
      rows: a.topProducts.map((p) => [p.productName, p.categoryName, p.qty, money(p.sales)]),
      moneyColumns: [4],
    },
  ];

  // Staff sales are excluded from every figure above, so the sheet has to say
  // they happened — otherwise a reader reconciling the export against the till
  // finds goods that left with no line explaining them.
  if (a.staffCount > 0) {
    sections.push({
      title: 'Staff Sales (unpaid — excluded from every figure above)',
      headers: ['Count', 'Value (Rs.)'],
      rows: [[a.staffCount, money(a.staffTotal)]],
      moneyColumns: [2],
    });
  }

  return sections;
}

function scopeLine(a: SalesAnalytics): string {
  const branch = a.branchName ?? 'All Branches';
  const period = a.from === a.effectiveTo ? a.from : `${a.from} — ${a.effectiveTo}`;
  return `${branch}   |   ${period}`;
}

export async function salesAnalyticsExcel(a: SalesAnalytics): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mountain Bakes ERP';
  wb.created = new Date();

  // One worksheet per section rather than one sheet with four stacked tables:
  // stacked tables cannot be sorted or filtered without dragging the other
  // three around with them.
  for (const section of buildSections(a)) {
    // Excel refuses a sheet name over 31 chars or containing []:*?/\
    const sheet = wb.addWorksheet(section.title.replace(/[[\]:*?/\\]/g, '').slice(0, 31));

    const scope = sheet.addRow([scopeLine(a)]);
    scope.font = { italic: true, color: { argb: 'FF6B3B1E' }, size: 10 };
    sheet.addRow([]);

    sheet.addRow(section.headers).eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF97316' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    for (const row of section.rows) {
      const added = sheet.addRow(row);
      for (const col of section.moneyColumns) {
        added.getCell(col).numFmt = '#,##0.00';
      }
    }

    sheet.columns.forEach((c, i) => { c.width = i === 0 ? 28 : 18; });
  }

  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

export function salesAnalyticsPDF(a: SalesAnalytics): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fillColor('#F97316').fontSize(24).font('Helvetica-Bold').text('Mountain Bakes', { align: 'center' });
    doc.fillColor('#6B3B1E').fontSize(13).font('Helvetica').text('Daily Sales', { align: 'center' });
    doc.fillColor('#333').fontSize(9).text(scopeLine(a), { align: 'center' });
    doc.fillColor('#999').fontSize(8).text(`Generated: ${format(new Date(), 'dd MMM yyyy HH:mm')}`, { align: 'center' });
    doc.moveDown(1.2);

    const left = 40;
    const width = 515;

    for (const section of buildSections(a)) {
      // A section header stranded at the foot of a page is worse than a page
      // break one row early.
      if (doc.y > 690) doc.addPage();

      doc.fillColor('#6B3B1E').fontSize(12).font('Helvetica-Bold').text(section.title, left, doc.y);
      doc.moveDown(0.4);

      const colW = width / Math.max(section.headers.length, 1);
      let y = doc.y;
      doc.fillColor('#6B3B1E').fontSize(9).font('Helvetica-Bold');
      section.headers.forEach((h, i) => doc.text(h, left + i * colW, y, { width: colW - 6 }));
      doc.moveDown(0.4);
      doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor('#F97316').stroke();
      doc.moveDown(0.3);

      doc.fillColor('#333').font('Helvetica').fontSize(9);
      if (section.rows.length === 0) {
        doc.text('No data for this period.', left, doc.y);
        doc.moveDown(0.7);
      }
      for (const row of section.rows) {
        if (doc.y > 760) doc.addPage();
        y = doc.y;
        row.forEach((c, i) => {
          const isMoney = section.moneyColumns.includes(i + 1);
          const text = typeof c === 'number' && isMoney ? c.toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : String(c ?? '');
          doc.text(text, left + i * colW, y, { width: colW - 6, align: typeof c === 'number' ? 'right' : 'left' });
        });
        doc.moveDown(0.65);
      }
      doc.moveDown(0.8);
    }

    doc.moveDown(1);
    doc.fillColor('#999').fontSize(8).text('Mountain Bakes ERP — Confidential', left, doc.y, { width, align: 'center' });
    doc.end();
  });
}

export function salesAnalyticsCSV(a: SalesAnalytics): string {
  const quote = (c: Cell) => `"${String(c ?? '').replace(/"/g, '""')}"`;
  const lines: string[] = [quote(`Mountain Bakes — Daily Sales`), quote(scopeLine(a)), ''];

  for (const section of buildSections(a)) {
    lines.push(quote(section.title));
    lines.push(section.headers.map(quote).join(','));
    for (const row of section.rows) lines.push(row.map(quote).join(','));
    lines.push('');
  }

  return lines.join('\n');
}
