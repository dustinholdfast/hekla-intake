/**
 * Where prices come from: CardTrader's marketplace, read with the tenant's own connected account.
 * A tenant that has not connected CardTrader gets no price, with a source line that says why.
 */
import { cardTraderMarket } from "./cardtrader.ts";
import { connectionSecret } from "./connections.ts";

export type PricedCard = { game: string | null; setNumber?: string | null; setIdentifier?: string | null; collectorNumber: string | null; finish: string | null; condition: string | null };
export type PriceLookup = (env: Env, card: PricedCard) => Promise<{ price: number | null; source: string }>;

const TOKEN_MS = 60_000;
const tokens = new Map<string, { token: string | null; at: number }>();

async function tokenFor(env: Env, tenantId: string): Promise<string | null> {
  const hit = tokens.get(tenantId);
  if (hit && Date.now() - hit.at < TOKEN_MS) return hit.token;
  const token = await connectionSecret(env, tenantId, "cardtrader");
  tokens.set(tenantId, { token, at: Date.now() });
  return token;
}

export const cardTraderPrice: PriceLookup = async (env, card) => {
  const tenantId = env.TENANT_ID;
  const token = tenantId ? await tokenFor(env, tenantId) : null;
  if (!tenantId || !token) return { price: null, source: "CardTrader: not connected. Connect it in Settings to get prices." };
  return cardTraderMarket(token, tenantId, card);
};
