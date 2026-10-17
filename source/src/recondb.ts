/** Neon storage for the three-way reconcile: TCGplayer snapshot, confirmed matches, the action log. */
import { db } from "./tenants.ts";
import type { TcgRow } from "./tcgcsv.ts";

export type SnapshotInfo = { id: number; uploadedAt: string; uploadedBy: string; filename: string | null; totalRows: number; stockedRows: number };

export async function saveSnapshot(env: Env, tenantId: string, userId: string, filename: string | null, totalRows: number, columns: string[], rows: TcgRow[]): Promise<SnapshotInfo> {
  const sql = db(env);
  const [snap] = await sql.query(
    `insert into tcgplayer_snapshots (tenant_id, uploaded_by, filename, total_rows, stocked_rows, columns) values ($1, $2, $3, $4, $5, $6::jsonb)
     returning id, uploaded_at`,
    [tenantId, userId, filename, totalRows, rows.length, JSON.stringify(columns)],
  );
  const id = Number(snap!.id);
  try {
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000).map((r) => ({ snapshot_id: id, tcgplayer_id: r.tcgplayerId, product_line: r.productLine, set_name: r.setName, product_name: r.productName, number: r.number, rarity: r.rarity, condition: r.condition, total_qty: r.totalQty, price_cents: r.priceCents, market_cents: r.marketCents }));
    await sql.query(
      `insert into tcgplayer_rows (snapshot_id, tcgplayer_id, product_line, set_name, product_name, number, rarity, condition, total_qty, price_cents, market_cents)
       select * from jsonb_to_recordset($1::jsonb) as x(snapshot_id bigint, tcgplayer_id text, product_line text, set_name text, product_name text, number text,
         rarity text, condition text, total_qty integer, price_cents integer, market_cents integer)`,
      [JSON.stringify(chunk)],
    );
  }
  } catch (error) {
    // A half-written upload must not become the latest snapshot.
    await sql.query("delete from tcgplayer_snapshots where id = $1", [id]).catch(() => undefined);
    throw error;
  }
  // Keep only the latest snapshot (rows go with it).
  await sql.query("delete from tcgplayer_snapshots where tenant_id = $1 and id <> $2", [tenantId, id]);
  return { id, uploadedAt: new Date(snap!.uploaded_at as string).toISOString(), uploadedBy: userId, filename, totalRows, stockedRows: rows.length };
}

export async function latestSnapshot(env: Env, tenantId: string): Promise<{ info: SnapshotInfo; rows: TcgRow[] } | null> {
  const sql = db(env);
  const [s] = await sql.query("select id, uploaded_at, uploaded_by, filename, total_rows, stocked_rows from tcgplayer_snapshots where tenant_id = $1 order by uploaded_at desc limit 1", [tenantId]);
  if (!s) return null;
  const rows = await sql.query("select * from tcgplayer_rows where snapshot_id = $1", [s.id]);
  return {
    info: { id: Number(s.id), uploadedAt: new Date(s.uploaded_at as string).toISOString(), uploadedBy: String(s.uploaded_by), filename: (s.filename as string) ?? null, totalRows: Number(s.total_rows), stockedRows: Number(s.stocked_rows) },
    rows: rows.map((r) => ({ tcgplayerId: String(r.tcgplayer_id), productLine: (r.product_line as string) ?? null, setName: (r.set_name as string) ?? null, productName: String(r.product_name ?? ""), number: (r.number as string) ?? null, rarity: (r.rarity as string) ?? null, condition: (r.condition as string) ?? null, totalQty: Number(r.total_qty), priceCents: r.price_cents == null ? null : Number(r.price_cents), marketCents: r.market_cents == null ? null : Number(r.market_cents) })),
  };
}

export async function confirmedMatches(env: Env, tenantId: string): Promise<Map<string, string>> {
  const rows = await db(env).query("select record_id, tcgplayer_id from tcgplayer_matches where tenant_id = $1", [tenantId]);
  return new Map(rows.map((r) => [String(r.record_id), String(r.tcgplayer_id)]));
}

/** Confirms record ↔ SKU. A SKU confirmed for another row moves to this one. */
export async function confirmMatch(env: Env, tenantId: string, recordId: string, tcgplayerId: string, userId: string): Promise<void> {
  const sql = db(env);
  await sql.query("delete from tcgplayer_matches where tenant_id = $1 and tcgplayer_id = $2 and record_id <> $3", [tenantId, tcgplayerId, recordId]);
  await sql.query(
    `insert into tcgplayer_matches (tenant_id, record_id, tcgplayer_id, confirmed_by) values ($1, $2, $3, $4)
     on conflict (tenant_id, record_id) do update set tcgplayer_id = excluded.tcgplayer_id, confirmed_by = excluded.confirmed_by, confirmed_at = now()`,
    [tenantId, recordId, tcgplayerId, userId],
  );
}
export async function removeMatch(env: Env, tenantId: string, recordId: string): Promise<boolean> {
  return (await db(env).query("delete from tcgplayer_matches where tenant_id = $1 and record_id = $2 returning record_id", [tenantId, recordId])).length > 0;
}

export type ReconAction = "check_cardtrader" | "tcgplayer_upload" | "tcgplayer_confirm" | "tcgplayer_unconfirm" | "tcgplayer_sku_write" | "tcgplayer_import_csv" | "cardtrader_set" | "airtable_set";
export async function logAction(env: Env, tenantId: string, userId: string, action: ReconAction, recordId: string | null, detail: Record<string, unknown>): Promise<void> {
  await db(env).query("insert into reconcile_actions (tenant_id, user_id, action, record_id, detail) values ($1, $2, $3, $4, $5::jsonb)", [tenantId, userId, action, recordId, JSON.stringify(detail)]);
}
export async function recentActions(env: Env, tenantId: string, limit = 50): Promise<{ id: number; at: string; userId: string; action: string; recordId: string | null; detail: unknown }[]> {
  const rows = await db(env).query("select id, created_at, user_id, action, record_id, detail from reconcile_actions where tenant_id = $1 order by created_at desc, id desc limit $2", [tenantId, limit]);
  return rows.map((r) => ({ id: Number(r.id), at: new Date(r.created_at as string).toISOString(), userId: String(r.user_id), action: String(r.action), recordId: (r.record_id as string) ?? null, detail: r.detail }));
}
