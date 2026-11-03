// Builds the word list and store layout into the function, so a new worker can answer without fetching them first.
// Run it when the catalogue or store layout changes, then deploy. Until then, the server's own ping catches each worker
// up soon after it starts, so a change is never lost, it just isn't instant.
//   node scripts/make_snapshot.mjs
import { writeFileSync } from "node:fs";
import { sql } from "./sb.mjs";

const [{ info, words }] = await sql("select store_info() as info, all_words() as words");
const text = JSON.stringify({ info, words });
const file = new URL("../supabase/functions/api/snapshot.mjs", import.meta.url);
writeFileSync(file, `// Built by scripts/make_snapshot.mjs from store_info() and all_words(). Don't edit by hand.\nexport const SNAPSHOT = JSON.parse(${JSON.stringify(text)});\n`);
console.log(`snapshot: ${words.length} words, ${info.terms.length} terms, ${info.aisles.length} aisles, ${Math.round(text.length / 1024)} KB`);
