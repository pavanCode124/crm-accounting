import 'server-only';
import { deflateRawSync } from 'node:zlib';

/**
 * A spreadsheet writer, in one file, with no dependency behind it.
 *
 * WHY NOT A LIBRARY. An .xlsx is a zip of five small XML parts, and this
 * product needs exactly one thing from it: a workbook whose sheets, column
 * widths and number formats match a statement an agency already receives from
 * its marketplaces and hands to its auditor. Every spreadsheet library in the
 * ecosystem brings a styling DSL, a formula engine and a READER along with it,
 * and the reader is the part that keeps appearing in advisories — for a feature
 * that only ever writes. The writer is 200 lines; the arithmetic that fills it,
 * in exports.ts, is the part worth reviewing.
 *
 * WHY NOT CSV. The attached statement is three sheets with a merged title, a
 * frozen header row and money that has to add up in Excel's own total. CSV is
 * one sheet of strings: the accountant re-applies the formats every month, and
 * a figure that arrives as text does not sum. Where a single flat list IS the
 * right answer, `toCsv` at the bottom is here too.
 *
 * ---------------------------------------------------------------------------
 * MONEY CROSSES THIS BOUNDARY AS A DECIMAL, DELIBERATELY
 * ---------------------------------------------------------------------------
 * Everywhere else in this codebase an amount is an integer in paise, because
 * `0.1 + 0.2` has no place in a ledger. A spreadsheet cell is the one honest
 * exception: Excel has no integer-minor-unit type, and writing paise would put
 * 19808000 in a column headed "Rs". So `money()` divides by 100 at the very
 * last step — the same edge `fmt()` in src/lib/money.ts occupies for the
 * screen — and nothing downstream of it does arithmetic the books rely on.
 */

// ---------------------------------------------------------------------------
// The cell model
// ---------------------------------------------------------------------------

/**
 * The styles a finance sheet needs, named rather than numbered.
 *
 * They map to fixed indices in `cellXfs` below. A name here is the contract
 * the sheet builders in exports.ts use; the indices are an implementation
 * detail that must never leak into them.
 */
export type CellStyle =
  | 'plain' | 'bold' | 'title' | 'header' | 'money' | 'moneyBold'
  | 'date' | 'rate' | 'int' | 'section' | 'sectionMoney' | 'wrap' | 'muted';

export interface Cell {
  v: string | number | null;
  s?: CellStyle;
}

export type CellInput = Cell | string | number | null | undefined;

export interface Sheet {
  name: string;
  rows: CellInput[][];
  /** Column widths in characters, left to right. */
  cols?: number[];
  /** Rows above the split, so a 48-column statement scrolls under its header. */
  freezeRows?: number;
  freezeCols?: number;
  /** A1-style ranges, e.g. `B2:F2` for a merged title. */
  merges?: string[];
}

/** A money cell: minor units in, a formatted decimal cell out. */
export function money(
  minor: number | null | undefined,
  style: 'money' | 'moneyBold' | 'sectionMoney' = 'money',
): Cell {
  if (minor === null || minor === undefined) return { v: null, s: style };
  return { v: minor / 100, s: style };
}

/**
 * The dash the attached statement writes for a nil figure.
 *
 * A zero and an absent figure read differently to an accountant: "-" says this
 * charge did not arise, `0.00` says it arose and came to nothing. The source
 * workbook uses the dash throughout, and a column of them is also far easier
 * to scan for the two rows that are not nil.
 */
export function moneyOrDash(
  minor: number,
  style: 'money' | 'moneyBold' | 'sectionMoney' = 'money',
): Cell {
  return minor === 0 ? { v: '-', s: 'plain' } : money(minor, style);
}

/** A percentage held as a plain number, which is how the source sheet writes it. */
export function rate(bps: number | null | undefined): Cell {
  if (bps === null || bps === undefined) return { v: null };
  return { v: bps / 100, s: 'rate' };
}

export function text(v: string | null | undefined, style: CellStyle = 'plain'): Cell {
  return { v: v ?? '-', s: style };
}

function normalise(c: CellInput): Cell {
  if (c === null || c === undefined) return { v: null };
  if (typeof c === 'object') return c;
  return { v: c };
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

/**
 * Escape for XML text and attributes both.
 *
 * It also strips the control characters XML 1.0 forbids outright. They reach
 * here from pasted supplier names and from CRM fields that once held a vertical
 * tab, and a single 0x0B is the difference between a workbook and a file Excel
 * refuses to open without saying which cell is at fault.
 */
function esc(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 1-indexed column number to a spreadsheet column name: 1 is A, 27 is AA. */
export function colName(n: number): string {
  let s = '';
  let v = n;
  while (v > 0) {
    const r = (v - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    v = Math.floor((v - 1) / 26);
  }
  return s;
}

const STYLE_INDEX: Record<CellStyle, number> = {
  plain: 0, bold: 1, title: 2, header: 3, money: 4, moneyBold: 5,
  date: 6, rate: 7, int: 8, section: 9, sectionMoney: 10, wrap: 11, muted: 12,
};

/**
 * The style table.
 *
 * Hand-written because it never varies: the same thirteen styles serve every
 * sheet this product exports, and deriving them from the cells used would add
 * a pass over the data to save nothing. Custom number formats start at 164
 * because 0 to 163 are reserved by the format itself.
 */
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="4">
<numFmt numFmtId="164" formatCode="#,##0.00;[Red]-#,##0.00"/>
<numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd"/>
<numFmt numFmtId="166" formatCode="0.00"/>
<numFmt numFmtId="167" formatCode="#,##0"/>
</numFmts>
<fonts count="5">
<font><sz val="10"/><name val="Calibri"/></font>
<font><b/><sz val="10"/><name val="Calibri"/></font>
<font><b/><sz val="13"/><color rgb="FF1F3864"/><name val="Calibri"/></font>
<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><sz val="10"/><color rgb="FF808080"/><name val="Calibri"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEEF0F5"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="3">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border>
<border><left style="thin"><color rgb="FF1F3864"/></left><right style="thin"><color rgb="FF1F3864"/></right><top style="thin"><color rgb="FF1F3864"/></top><bottom style="thin"><color rgb="FF1F3864"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="13">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="2" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
</styleSheet>`;

function sheetXml(sheet: Sheet): string {
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
  ];

  const fr = sheet.freezeRows ?? 0;
  const fc = sheet.freezeCols ?? 0;
  if (fr || fc) {
    // `activePane` has to name the pane the split leaves active, and it differs
    // for a horizontal, a vertical and a corner split. Excel tolerates a wrong
    // one; LibreOffice opens the sheet already scrolled into the frozen region.
    const pane = fr && fc ? 'bottomRight' : fr ? 'bottomLeft' : 'topRight';
    parts.push(
      '<sheetViews><sheetView workbookViewId="0">',
      `<pane ${fc ? `xSplit="${fc}" ` : ''}${fr ? `ySplit="${fr}" ` : ''}`,
      `topLeftCell="${colName(fc + 1)}${fr + 1}" activePane="${pane}" state="frozen"/>`,
      '</sheetView></sheetViews>',
    );
  }
  parts.push('<sheetFormatPr defaultRowHeight="14.5"/>');

  if (sheet.cols?.length) {
    parts.push('<cols>');
    for (const [i, w] of sheet.cols.entries()) {
      parts.push(`<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`);
    }
    parts.push('</cols>');
  }

  parts.push('<sheetData>');
  for (const [r, row] of sheet.rows.entries()) {
    const cells: string[] = [];
    for (const [c, raw] of row.entries()) {
      const cell = normalise(raw);
      if (cell.v === null || cell.v === '') continue;
      const ref = `${colName(c + 1)}${r + 1}`;
      const style = cell.s ? ` s="${STYLE_INDEX[cell.s]}"` : '';
      if (typeof cell.v === 'number') {
        // NaN and Infinity have no cell representation, and writing one makes
        // the whole file unreadable rather than the single cell wrong — so an
        // arithmetic accident becomes a blank, not a repair dialog.
        if (!Number.isFinite(cell.v)) continue;
        cells.push(`<c r="${ref}"${style}><v>${cell.v}</v></c>`);
      } else {
        cells.push(`<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(cell.v)}</t></is></c>`);
      }
    }
    if (cells.length) parts.push(`<row r="${r + 1}">${cells.join('')}</row>`);
  }
  parts.push('</sheetData>');

  // After sheetData, always: the schema's element order is fixed and Excel
  // rejects mergeCells placed before it.
  if (sheet.merges?.length) {
    parts.push(`<mergeCells count="${sheet.merges.length}">`);
    for (const m of sheet.merges) parts.push(`<mergeCell ref="${esc(m)}"/>`);
    parts.push('</mergeCells>');
  }
  parts.push('</worksheet>');
  return parts.join('');
}

/**
 * A sheet name Excel will accept.
 *
 * Thirty-one characters, none of `[ ] : * ? / \`, and not blank. A name that
 * breaks any of those opens as a repair dialog rather than an error, which is
 * the worst available failure for a file someone is about to send an auditor.
 */
function sheetName(name: string, index: number): string {
  const clean = name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31);
  return clean || `Sheet${index + 1}`;
}

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

interface Entry { name: string; data: Buffer }

/**
 * Build the zip.
 *
 * Deflate rather than store, because a 48-column statement of three thousand
 * orders is mostly repeated state names and HSN codes and compresses about
 * tenfold — the difference between a download and an attachment that bounces.
 * No zip64 and no data descriptors: both sizes are known before the header is
 * written, and a workbook large enough to need zip64 would have passed Excel's
 * own row limit long before.
 */
function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const deflated = deflateRawSync(e.data, { level: 6 });
    // Only if it actually helped: a tiny part can deflate larger than it was.
    const stored = deflated.length >= e.data.length;
    const body = stored ? e.data : deflated;
    const method = stored ? 0 : 8;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed to extract
    local.writeUInt16LE(0x0800, 6);        // flag: the name is UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);            // modified time
    local.writeUInt16LE(0x21, 12);         // modified date: 1 Jan 1980, the zip epoch
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);            // no extra field
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}

// ---------------------------------------------------------------------------
// The workbook
// ---------------------------------------------------------------------------

export function buildXlsx(sheets: Sheet[]): Buffer {
  if (!sheets.length) throw new Error('A workbook needs at least one sheet.');
  const names = sheets.map((s, i) => sheetName(s.name, i));

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const entries: Entry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES_XML, 'utf8') },
    ...sheets.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: Buffer.from(sheetXml(s), 'utf8'),
    })),
  ];
  return zip(entries);
}

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * A filename safe in a Content-Disposition header and on every filesystem.
 *
 * A quote or a semicolon in a document number would end the header early, and
 * a browser handed a truncated disposition saves the file as the route's last
 * path segment — `xlsx`, with no extension and no clue what it holds.
 */
export function downloadName(parts: Array<string | null | undefined>, ext = 'xlsx'): string {
  const body = parts.filter(Boolean).join(' - ')
    .replace(/[^A-Za-z0-9 _.()-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-. ]+|[-. ]+$/g, '')
    .slice(0, 120);
  return `${body || 'export'}.${ext}`;
}

/**
 * The flat-list escape hatch, for a single table with no layout to preserve.
 *
 * It opens with a BOM, because Excel on Windows reads a UTF-8 CSV in the system
 * codepage without one and renders every rupee sign and every accented supplier
 * name as mojibake.
 */
export function toCsv(rows: Array<Array<string | number | null>>): string {
  const body = rows.map((row) => row.map((v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
  return `﻿${body}`;
}
