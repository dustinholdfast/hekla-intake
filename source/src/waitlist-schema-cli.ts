/**
 * Dry-run by default. Prints the Waitlist fields Phase 2 would add.
 * Does not call Airtable unless --apply is passed, and this task does not pass it.
 *
 *   npm run schema
 *   npm run schema -- --existing "Language,Qty,Status,Finish"
 *   npm run schema -- --apply
 */
import { pathToFileURL } from "node:url";
import { runSchemaCli } from "./waitlist-schema.ts";

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  runSchemaCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Schema plan failed.");
    process.exitCode = 1;
  });
}
