// Small helpers for talking to the Supabase project from this PC. Secrets come from local/.env, which git ignores.
import { readFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
export const env = Object.fromEntries(readFileSync(new URL("local/.env", ROOT), "utf8").split(/\r?\n/).filter(l => l.includes("=")).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const REF = env.SUPABASE_PROJECT_REF, TOKEN = env.SUPABASE_ACCESS_TOKEN;
export const BASE = `https://${REF}.supabase.co`;
export const API = `${BASE}/functions/v1/api`;

// Runs SQL as the project owner, through Supabase's management API.
export async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SQL ${res.status}: ${text.slice(0, 600)}`);
  return JSON.parse(text);
}

let serviceKey = null;
export async function secretKey() {
  if (serviceKey) return serviceKey;
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/api-keys?reveal=true`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const keys = await res.json();
  const k = keys.find(x => x.name === "service_role") || keys.find(x => x.type === "secret");
  serviceKey = k.api_key;
  return serviceKey;
}

// Inserts rows through the REST API, in batches.
export async function insert(table, rows, batch = 1000) {
  const key = await secretKey();
  for (let i = 0; i < rows.length; i += batch) {
    const res = await fetch(`${BASE}/rest/v1/${table}`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows.slice(i, i + batch)),
    });
    if (!res.ok) throw new Error(`insert ${table} ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
}

// Calls the deployed API the same way the phone does.
export async function ask(body) {
  const res = await fetch(API, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`api ${res.status}: ${text.slice(0, 300)}`);
  return text.trim().split("\n").map(l => JSON.parse(l));
}
