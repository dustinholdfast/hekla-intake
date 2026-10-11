import { buildCreateFields, collectorVariants, SET_IDENTIFIER_MAX, setIdentityOf, type DraftCard } from "./fields.ts";
import { canonicalCondition, canonicalFinish, canonicalSet, finishesFor, type Game } from "./sets.ts";

export type ParsedRow = {
  line: number;
  raw: string;
  card?: DraftCard;
  error?: string;
};

const QTY_RE = /^(?:x\s*)?(\d+)$/i;

function splitLine(line: string): { tokens: string[]; delimiter: string } {
  if (line.includes("\t")) {
    return { tokens: line.split("\t").map((part) => part.trim()).filter((part) => part.length > 0), delimiter: "\t" };
  }
  if (line.includes(",")) {
    return { tokens: line.split(",").map((part) => part.trim()).filter((part) => part.length > 0), delimiter: "," };
  }
  return { tokens: line.split(/\s+/).filter((part) => part.length > 0), delimiter: " " };
}

function parseQtyToken(token: string): number | null {
  const match = QTY_RE.exec(token.trim());
  if (!match?.[1]) return null;
  const qty = Number(match[1]);
  if (!Number.isInteger(qty) || qty < 1 || qty > 250) return null;
  return qty;
}

/** One card per line. Blank lines and # comments are dropped. Game comes from the sticky picker. */
export function parseBulk(text: string, game: Game = "Lorcana"): ParsedRow[] {
  const lines = text.split(/\r?\n/);
  const rows: ParsedRow[] = [];
  lines.forEach((rawLine, index) => {
    const raw = rawLine.trim();
    if (!raw || raw.startsWith("#")) return;
    const line = index + 1;
    const { tokens, delimiter } = splitLine(raw);
    if (tokens.length > 0 && tokens[0]?.toLowerCase() === "set") return;

    if (tokens.length < 4) {
      rows.push({
        line,
        raw,
        error: "Need set, collector number, finish, and condition. Quantity and name are optional.",
      });
      return;
    }

    const setToken = (tokens[0] ?? "").trim();
    const finish = canonicalFinish(tokens[2] ?? "");
    const condition = canonicalCondition(tokens[3] ?? "");
    const collectorNumber = (tokens[1] ?? "").trim();
    const setNumber = game === "Lorcana" ? canonicalSet(setToken) : null;

    if (game === "Lorcana" && !setNumber) {
      rows.push({ line, raw, error: `“${setToken}” is not a Lorcana set number.` });
      return;
    }
    if (game !== "Lorcana" && (!setToken || setToken.length > SET_IDENTIFIER_MAX)) {
      rows.push({ line, raw, error: "Set identifier is missing or too long." });
      return;
    }
    if (!collectorNumber || collectorNumber.length > 40) {
      rows.push({ line, raw, error: "Collector number is missing." });
      return;
    }
    if (!finish || !finishesFor(game).includes(finish)) {
      rows.push({ line, raw, error: `“${tokens[2]}” is not a ${game} finish. Use ${finishesFor(game).join(", ")}.` });
      return;
    }
    if (!condition) {
      rows.push({ line, raw, error: `“${tokens[3]}” is not a condition. Use NM, LP, MP, HP, or DMG.` });
      return;
    }

    const rest = tokens.slice(4);
    let qty = 1;
    let nameTokens = rest;
    if (rest.length > 0) {
      const maybeQty = parseQtyToken(rest[0] ?? "");
      if (maybeQty !== null) {
        qty = maybeQty;
        nameTokens = rest.slice(1);
      } else if (/^\d+$/.test(rest[0] ?? "")) {
        rows.push({ line, raw, error: "Quantity must be a whole number from 1 to 250." });
        return;
      }
    }

    const nameJoiner = delimiter === "," ? ", " : " ";
    const cardName = nameTokens.join(nameJoiner).trim();
    let card: DraftCard;
    if (game === "Lorcana") {
      if (!setNumber) return;
      card = { game, setNumber, collectorNumber, finish, condition, qty };
    } else {
      card = { game, setIdentifier: setToken, collectorNumber, finish, condition, qty };
    }
    if (cardName) {
      if (cardName.length > 180) {
        rows.push({ line, raw, error: "Card name is too long." });
        return;
      }
      card.cardName = cardName;
    }

    // Prove the row can be written with the create whitelist before preview.
    buildCreateFields(card);
    rows.push({ line, raw, card });
  });
  return rows;
}

export function samePrinting(
  a: DraftCard,
  other: { game: string; setNumber?: string | null; setIdentifier?: string | null; collectorNumber: string; finish: string },
): boolean {
  if (a.game !== other.game || a.finish !== other.finish) return false;
  if (setIdentityOf(a) !== setIdentityOf(other)) return false;
  const wanted = new Set(collectorVariants(a.collectorNumber).map((value) => value.toLowerCase()));
  return collectorVariants(other.collectorNumber).some((value) => wanted.has(value.toLowerCase()));
}

export { collectorVariants };
