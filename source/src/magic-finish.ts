/**
 * Magic finishes on the intake form.
 *
 * CardTrader does not have a Borderless/Showcase/Etched property. A Magic blueprint's `version`
 * is the treatment (null for the ordinary printing, otherwise "Borderless", "Extended Art",
 * "Showcase", "Etched", "Borderless | Surge Foil", …). Foil vs non-foil is the editable
 * `mtg_foil` property on that blueprint. One finish choice is one blueprint plus one foil value.
 *
 * The collector number on the card picks the printing. Other treatments of the same card in the
 * set (and its Collectors expansion) are offered too, and choosing one saves that printing's
 * collector number so the listing uses the matching blueprint.
 */
import { riftboundNumberKey } from "./preview.ts";

export const MAGIC_FALLBACK_FINISHES = ["Normal", "Foil"] as const;

/** Waitlist Finish choices that already exist for Lorcana and Riftbound. */
export const EXISTING_FINISH_CHOICES = new Set(["Normal", "Foil", "Enchanted", "Special"]);

/**
 * True when saving this finish has to add an Airtable choice.
 * Typecast adds the choice and does not remove Normal, Foil, Enchanted, or Special.
 */
export function finishNeedsNewChoice(finish: string): boolean {
  return !EXISTING_FINISH_CHOICES.has(finish);
}

export function airtableWriteTypecast(fields: { Finish?: unknown }): boolean {
  return typeof fields.Finish === "string" && finishNeedsNewChoice(fields.Finish);
}

export type FinishBlueprint = {
  id: number;
  name: string;
  version?: string | null;
  category_id: number;
  fixed_properties?: { collector_number?: unknown };
  editable_properties?: { name?: string; possible_values?: unknown[] }[];
};

export type MagicFinishOption<B extends FinishBlueprint = FinishBlueprint> = {
  /** Stored on the Waitlist Finish field and sent to CardTrader. */
  finish: string;
  /** Dropdown text. Includes the collector number when it is not the one typed. */
  label: string;
  blueprintId: number;
  /** null when the blueprint has no foil switch. */
  foil: boolean | null;
  collectorNumber: string;
  version: string | null;
  blueprint: B;
};

const FOIL_WORD = /\bfoil\b/i;
const MAGIC_FINISH_TEXT = /^[A-Za-z0-9][A-Za-z0-9 '&./|+()-]{0,79}$/;

export function canonicalMagicFinish(input: string): string | null {
  const raw = input.trim().replace(/\s+/g, " ");
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === "normal" || lower === "n" || lower === "nonfoil" || lower === "non-foil" || lower === "regular") return "Normal";
  if (lower === "foil" || lower === "f") return "Foil";
  if (lower === "enchanted" || lower === "special") return null;
  if (!MAGIC_FINISH_TEXT.test(raw)) return null;
  return raw;
}

function nameKey(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/['\u2019`]/g, "").split(/[^a-z0-9]+/).filter(Boolean).join(" ");
}

function collectorOf(blueprint: FinishBlueprint): string {
  const raw = blueprint.fixed_properties?.collector_number;
  return raw == null ? "" : String(raw).trim();
}

function versionOf(blueprint: FinishBlueprint): string | null {
  const version = (blueprint.version ?? "").replace(/\s+/g, " ").trim();
  return version || null;
}

/** Foil values CardTrader allows on this blueprint. null means there is no foil property. */
export function foilChoices(blueprint: FinishBlueprint): Array<boolean | null> {
  const prop = (blueprint.editable_properties ?? []).find((p) => typeof p.name === "string" && p.name.endsWith("_foil"));
  if (!prop) return [null];
  const values: boolean[] = [];
  for (const value of Array.isArray(prop.possible_values) ? prop.possible_values : []) {
    if (value === true || value === "true") values.push(true);
    else if (value === false || value === "false") values.push(false);
  }
  if (!values.length) return [false, true];
  return [...new Set(values)].sort((a, b) => Number(a) - Number(b));
}

export function magicFinishName(version: string | null | undefined, foil: boolean | null, choices: Array<boolean | null>): string {
  const treatment = (version ?? "").replace(/\s+/g, " ").trim();
  const both = choices.includes(true) && choices.includes(false);
  if (!treatment) return foil === true ? "Foil" : "Normal";
  if (foil === true && !FOIL_WORD.test(treatment)) return `${treatment} Foil`;
  if (foil === false && both && FOIL_WORD.test(treatment)) return `${treatment} Nonfoil`;
  return treatment;
}

export function magicFinishOptions<B extends FinishBlueprint>(
  blueprints: readonly B[],
  singlesCategoryId: number,
  collectorNumber: string,
): { cardName: string | null; options: MagicFinishOption<B>[]; reason?: string } {
  const singles = blueprints.filter((b) => b.category_id === singlesCategoryId);
  const key = riftboundNumberKey(collectorNumber);
  if (!key) return { cardName: null, options: [], reason: "No collector number." };
  const anchors = singles.filter((b) => riftboundNumberKey(collectorOf(b)) === key);
  if (!anchors.length) return { cardName: null, options: [], reason: `CardTrader has no card numbered ${collectorNumber.trim()} in this set.` };

  const names = new Set(anchors.map((b) => nameKey(b.name)).filter(Boolean));
  const anchorKeys = new Set(anchors.map((b) => riftboundNumberKey(collectorOf(b))));
  const nullVersions = singles.filter((b) => names.has(nameKey(b.name)) && !versionOf(b));
  const uniqueBase = nullVersions.length === 1 ? nullVersions[0] : null;
  const family = singles.filter((b) => {
    if (!names.has(nameKey(b.name))) return false;
    if (anchorKeys.has(riftboundNumberKey(collectorOf(b)))) return true;
    if (versionOf(b)) return true;
    return uniqueBase?.id === b.id;
  });

  const options: MagicFinishOption<B>[] = [];
  for (const blueprint of family) {
    const version = versionOf(blueprint);
    const choices = foilChoices(blueprint);
    const number = collectorOf(blueprint);
    for (const foil of choices) {
      const finish = magicFinishName(version, foil, choices);
      const different = Boolean(number) && riftboundNumberKey(number) !== key;
      options.push({
        finish,
        label: different ? `${finish} · #${number}` : finish,
        blueprintId: blueprint.id,
        foil,
        collectorNumber: number,
        version,
        blueprint,
      });
    }
  }

  const labelCount = new Map<string, number>();
  for (const option of options) labelCount.set(option.label, (labelCount.get(option.label) ?? 0) + 1);
  for (const option of options) {
    if ((labelCount.get(option.label) ?? 0) < 2) continue;
    const suffix = option.collectorNumber ? `#${option.collectorNumber}` : `blueprint ${option.blueprintId}`;
    option.label = option.label.includes(suffix) ? `${option.label} · ${option.blueprintId}` : `${option.finish} · ${suffix}`;
  }

  options.sort((a, b) => {
    const aAnchor = riftboundNumberKey(a.collectorNumber) === key ? 0 : 1;
    const bAnchor = riftboundNumberKey(b.collectorNumber) === key ? 0 : 1;
    if (aAnchor !== bAnchor) return aAnchor - bAnchor;
    if (Boolean(a.version) !== Boolean(b.version)) return a.version ? 1 : -1;
    const byNumber = a.collectorNumber.localeCompare(b.collectorNumber, undefined, { numeric: true });
    if (byNumber !== 0) return byNumber;
    return Number(a.foil === true) - Number(b.foil === true);
  });

  const cardName = anchors.find((b) => !versionOf(b))?.name ?? anchors[0]!.name;
  return { cardName, options };
}

export function chooseMagicFinish<B extends FinishBlueprint>(
  options: readonly MagicFinishOption<B>[],
  collectorNumber: string,
  finish: string,
): MagicFinishOption<B> | { reason: string } {
  const wanted = finish.trim().toLowerCase();
  const hits = options.filter((option) => option.finish.toLowerCase() === wanted);
  if (!hits.length) {
    const list = [...new Set(options.map((option) => option.finish))];
    return { reason: list.length ? `Finish must be ${list.join(", ")}.` : "CardTrader has no finishes for this card." };
  }
  const key = riftboundNumberKey(collectorNumber);
  const sameNumber = hits.filter((option) => riftboundNumberKey(option.collectorNumber) === key);
  const pool = sameNumber.length ? sameNumber : hits;
  if (pool.length === 1) return pool[0]!;
  const numbers = [...new Set(pool.map((option) => option.collectorNumber).filter(Boolean))];
  if (numbers.length > 1) {
    return { reason: `Several printings use ${pool[0]!.finish} (${numbers.map((number) => `#${number}`).join(", ")}). Enter the collector number on the card.` };
  }
  return { reason: `Several CardTrader blueprints use ${pool[0]!.finish}. List this one by hand.` };
}
