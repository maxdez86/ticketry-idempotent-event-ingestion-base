/** RFC 4180 style CSV: CRLF line endings, quotes doubled, fields quoted when needed. */

export type CsvCell = string | number | boolean | Date | null | undefined;

function escapeCell(value: CsvCell): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text = value instanceof Date ? value.toISOString() : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [header.map(escapeCell).join(",")];
  for (const row of rows) {
    if (row.length !== header.length) {
      throw new Error(`CSV row has ${row.length} cells, header has ${header.length}`);
    }
    lines.push(row.map(escapeCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
