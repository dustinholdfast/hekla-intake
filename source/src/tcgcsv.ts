/**
 * Parses a TCGplayer Seller Portal pricing export ("Export From Live" / "Export My Inventory").
 *
 * Expected header (16 columns, from TCGplayer's help article and a captured export):
 *   TCGplayer Id, Product Line, Set Name, Product Name, Title, Number, Rarity, Condition, TCG Market Price,
 *   TCG Direct Low, TCG Low Price With Shipping, TCG Low Price, Total Quantity, Add to Quantity,
 *   TCG Marketplace Price, Photo URL
 * Some accounts add more (e.g. "My Store Reserve Quantity", "My Store Price"), and the order may differ, so
 * columns are found by name. Only "TCGplayer Id", "Product Name" and "Total Quantity" are required.
 * "Export From Live" lists the whole catalog with Total Quantity 0 for cards you do not have; only rows with
 * a quantity are kept.
 */

export type TcgRow = {
  tcgplayerId: string; productLine: string | null; setName: string | null; productName: string; number: string | null;
  rarity: string | null; condition: string | null; totalQty: number; priceCents: number | null; marketCents: number | null;
};
export type TcgParse = { ok: true; rows: TcgRow[]; totalRows: number; columns: string[]; skippedBad: number; duplicateIds: number } | { ok: false; error: string };

export const MAX_TCG_CSV_BYTES = 15_000_000;

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, a UTF-8 BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let field = ""; let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); if (row.length > 1 || row[0] !== "") rows.push(row); }
  return rows;
}

const key = (h: string) => h.trim().toLowerCase().replace(/\s+/g, " ");
const cents = (v: string | undefined): number | null => {
  const s = (v ?? "").replace(/[$,\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};
const text = (v: string | undefined) => (v?.trim() ? v.trim().slice(0, 300) : null);

export function parseTcgExport(input: string): TcgParse {
  if (input.length > MAX_TCG_CSV_BYTES) return { ok: false, error: "That file is too large (15 MB at most)." };
  const table = parseCsv(input);
  if (table.length === 0) return { ok: false, error: "The file is empty." };
  const header = table[0]!.map((h) => h.trim());
  const at = new Map(header.map((h, i) => [key(h), i]));
  const col = (name: string) => at.get(key(name));
  const need = ["TCGplayer Id", "Product Name", "Total Quantity"].filter((n) => col(n) === undefined);
  if (need.length) return { ok: false, error: `This doesn't look like a TCGplayer pricing export: missing ${need.join(", ")}. Export it from Seller Portal → Pricing.` };
  const get = (r: string[], name: string) => { const i = col(name); return i === undefined ? undefined : r[i]; };
  const rows: TcgRow[] = []; const seen = new Set<string>();
  let skippedBad = 0; let duplicateIds = 0;
  for (const r of table.slice(1)) {
    const id = (get(r, "TCGplayer Id") ?? "").trim();
    const qtyText = (get(r, "Total Quantity") ?? "").trim();
    const qty = qtyText === "" ? 0 : Number(qtyText);
    if (!/^\d{1,12}$/.test(id) || !Number.isInteger(qty) || qty < 0) { skippedBad++; continue; }
    if (qty === 0) continue;
    if (seen.has(id)) { duplicateIds++; continue; }
    seen.add(id);
    rows.push({
      tcgplayerId: id, productLine: text(get(r, "Product Line")), setName: text(get(r, "Set Name")), productName: text(get(r, "Product Name")) ?? "",
      number: text(get(r, "Number")), rarity: text(get(r, "Rarity")), condition: text(get(r, "Condition")), totalQty: qty,
      priceCents: cents(get(r, "TCG Marketplace Price")), marketCents: cents(get(r, "TCG Market Price")),
    });
  }
  return { ok: true, rows, totalRows: table.length - 1, columns: header, skippedBad, duplicateIds };
}

/** "Near Mint Foil", "Lightly Played Holofoil - Japanese" → condition code, foil and language. */
export function parseTcgCondition(value: string | null): { condition: string | null; foil: boolean; language: string | null } {
  if (!value) return { condition: null, foil: false, language: null };
  const [main, lang] = value.split(/\s+-\s+/, 2) as [string, string | undefined];
  const lower = main.toLowerCase();
  const table: [string, string][] = [["near mint", "NM"], ["lightly played", "LP"], ["moderately played", "MP"], ["heavily played", "HP"], ["damaged", "DMG"]];
  const hit = table.find(([name]) => lower.startsWith(name));
  const rest = hit ? lower.slice(hit[0].length) : lower;
  return { condition: hit?.[1] ?? null, foil: /foil|holo/.test(rest), language: lang?.trim() || null };
}
