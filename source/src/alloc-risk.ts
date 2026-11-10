/**
 * Which way a CardTrader listing may be wrong after an allocation write Hekla could not prove (ct_retry_unverifiable).
 * "high" is the oversell case and wins whenever it cannot be ruled out. It is ruled out only when CardTrader shows
 * nothing listed (observed 0 or gone), or for a release when the listing is at or below where it was before the
 * release (from). Anything unknown (no recorded quantities) is "high".
 *
 * Why a reserve is never "low" while something is listed: a reserve that never landed, plus a sale at the same time,
 * reads exactly like a reserve that landed (observed = expected), and the listing still shows the held copies.
 */
export type ListingRisk = "high" | "low";

export function listingRisk(input: { direction: "reserve" | "release"; from: number | null; expected: number | null; observed: number | null; known: boolean }): ListingRisk {
  if (!input.known || input.expected === null) return "high";
  const observed = input.observed ?? 0; // null = the listing is gone
  if (observed <= 0) return "low";
  if (input.direction === "release" && input.from !== null && observed <= input.from) return "low";
  return "high";
}

export function riskWords(risk: ListingRisk): string {
  return risk === "high"
    ? "may be too high, check now (oversell risk: held copies may still be for sale)"
    : "may be too low (released copies may not be listed); no oversell risk";
}
