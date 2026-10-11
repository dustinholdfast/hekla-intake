/** Real Lorcana set numbers. Labels are display-only — intake never writes Set Name. */
export const SETS = [
  { id: "1", name: "The First Chapter" },
  { id: "2", name: "Rise of the Floodborn" },
  { id: "3", name: "Into the Inklands" },
  { id: "4", name: "Ursula's Return" },
  { id: "Q1", name: "Illumineer's Quest: Deep Trouble" },
  { id: "5", name: "Shimmering Skies" },
  { id: "6", name: "Azurite Sea" },
  { id: "7", name: "Archazia's Island" },
  { id: "8", name: "Reign of Jafar" },
  { id: "Q2", name: "Illumineer's Quest: Palace Heist" },
  { id: "9", name: "Fabled" },
  { id: "10", name: "Whispers in the Well" },
  { id: "11", name: "Winterspell" },
  { id: "12", name: "Wilds Unknown" },
  { id: "13", name: "Attack of the Vine!" },
  { id: "Q3", name: "Illumineer's Quest: The Great Hunny Rescue" },
  { id: "14", name: "Hyperia City" },
  { id: "P", name: "Promo / Other" },
] as const;

export type SetNumber = (typeof SETS)[number]["id"];

/** Airtable Game choices. Written exactly as named. */
export const GAMES = [
  "Lorcana",
  "Magic: The Gathering",
  "Riftbound",
  "Pokémon",
  "Yu-Gi-Oh!",
] as const;
export type Game = (typeof GAMES)[number];

/**
 * Live Airtable Finish choices. Holofoil, Reverse Holo, Etched, and Special
 * can be re-enabled once Dustin adds them on the Finish field.
 */
export const FINISHES = ["Normal", "Foil", "Enchanted"] as const;
export type Finish = (typeof FINISHES)[number];

/** Same three choices for every game, matching the Airtable Finish field. */
export const FINISHES_BY_GAME: Record<Game, readonly Finish[]> = {
  Lorcana: FINISHES,
  "Magic: The Gathering": FINISHES,
  Riftbound: FINISHES,
  "Pokémon": FINISHES,
  "Yu-Gi-Oh!": FINISHES,
};

export const CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"] as const;
export type Condition = (typeof CONDITIONS)[number];

export const RARITIES = [
  "Common",
  "Uncommon",
  "Rare",
  "Super Rare",
  "Legendary",
  "Enchanted",
  "Promo",
  "Special",
] as const;
export type Rarity = (typeof RARITIES)[number];

export const STATUSES = ["Waitlist", "Listed", "Sold", "Skip"] as const;
export type Status = (typeof STATUSES)[number];

/** Airtable Listed qty compared with this cap. Not live TCGPlayer inventory. */
export const LISTED_CAP = 100;

export const DEFAULT_BASE_ID = "app4Tjz72sZtVMQyp";
export const DEFAULT_TABLE_ID = "tblvHPu7dgDHA91bc";

const SET_BY_LOWER = new Map(SETS.map((set) => [set.id.toLowerCase(), set]));

const GAME_ALIASES: Record<string, Game> = {
  lorcana: "Lorcana",
  "magic: the gathering": "Magic: The Gathering",
  magic: "Magic: The Gathering",
  mtg: "Magic: The Gathering",
  riftbound: "Riftbound",
  pokemon: "Pokémon",
  "pokémon": "Pokémon",
  "yu-gi-oh!": "Yu-Gi-Oh!",
  "yu-gi-oh": "Yu-Gi-Oh!",
  yugioh: "Yu-Gi-Oh!",
  "yu gi oh": "Yu-Gi-Oh!",
};

export function canonicalSet(input: string): SetNumber | null {
  return SET_BY_LOWER.get(input.trim().toLowerCase())?.id ?? null;
}

export function canonicalGame(input: string): Game | null {
  return GAME_ALIASES[input.trim().toLowerCase()] ?? null;
}

/**
 * Game used for queue scope and dedupe.
 * Older Waitlist rows were created before Game existed; a blank value is Lorcana.
 * A non-empty value that is not a known choice stays unknown (null).
 */
export function effectiveGame(game: string | null | undefined): Game | null {
  if (!game?.trim()) return "Lorcana";
  return canonicalGame(game);
}

export function finishesFor(game: Game): readonly Finish[] {
  return FINISHES_BY_GAME[game];
}

export function setName(id: string | null | undefined): string | null {
  if (!id) return null;
  return SET_BY_LOWER.get(id.toLowerCase())?.name ?? null;
}

const FINISH_ALIASES: Record<string, Finish> = {
  normal: "Normal",
  n: "Normal",
  foil: "Foil",
  f: "Foil",
  enchanted: "Enchanted",
  e: "Enchanted",
};

const CONDITION_ALIASES: Record<string, Condition> = {
  nm: "NM",
  "near mint": "NM",
  nearmint: "NM",
  lp: "LP",
  "lightly played": "LP",
  lightlyplayed: "LP",
  mp: "MP",
  "moderately played": "MP",
  moderatelyplayed: "MP",
  hp: "HP",
  "heavily played": "HP",
  heavilyplayed: "HP",
  dmg: "DMG",
  damaged: "DMG",
  damage: "DMG",
};

export function canonicalFinish(input: string): Finish | null {
  return FINISH_ALIASES[input.trim().toLowerCase()] ?? null;
}

export function canonicalCondition(input: string): Condition | null {
  return CONDITION_ALIASES[input.trim().toLowerCase()] ?? null;
}

export function canonicalRarity(input: string): Rarity | null {
  const trimmed = input.trim().toLowerCase();
  return RARITIES.find((rarity) => rarity.toLowerCase() === trimmed) ?? null;
}

export function isStatus(input: string): input is Status {
  return (STATUSES as readonly string[]).includes(input);
}
