/**
 * Seed one opening movement per Waitlist row.
 *
 *   node --experimental-strip-types src/opening-cli.ts            # read Airtable, write nothing
 *   node --experimental-strip-types src/opening-cli.ts --apply    # append to Neon; a second run inserts nothing
 *
 * Reads Airtable with GET only. Does not change Qty, Status, Finish, or any other field.
 * Does not print secrets. Do not run --apply until migration 0008 is on the database and Dustin says go-live.
 */
import { runOpening } from "./opening.ts";

const HELP = `Opening balances for the inventory ledger.

  --apply     Append one opening movement per Waitlist row to Neon.
              Without this flag the script only reads Airtable and prints counts.

Needs TENANT_ID and AIRTABLE_API_KEY (or AIRTABLE_PAT). --apply also needs DATABASE_URL.
Values are never printed. Category and Sealed buy-list rows are not decremented.
Date Acquired is left blank. Normal is stored as Regular. Enchanted is stored as Holofoil.
Special rows are flagged for review and the finish is not guessed.`;

if (process.argv.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}

const apply = process.argv.includes("--apply");
runOpening({ apply, env: process.env })
  .then((report) => {
    console.log(JSON.stringify(report));
    if (!apply) console.log("Dry run only. Pass --apply after migration 0008 is on Neon and Dustin has approved go-live.");
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Opening entries failed.";
    console.error(message);
    process.exit(1);
  });
