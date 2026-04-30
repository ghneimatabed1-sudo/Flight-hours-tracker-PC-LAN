const SUPA_URL = process.env.SUPABASE_URL;
const MGMT = process.env.SUPABASE_MANAGEMENT_TOKEN;
const REF = SUPA_URL.match(/https:\/\/([^.]+)\.supabase\.co/)[1];
async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${MGMT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await r.text();
  if (!r.ok) { console.error(`SQL ${r.status}: ${text}`); return null; }
  return JSON.parse(text);
}
const PFX = "AUD_OPS_";
// pre-cleanup any leftover AUD_OPS_ rows from prior partial runs
const stmts = [
  `delete from currencies where pilot_id like '${PFX}%';`,
  `delete from sorties where pilot_id like '${PFX}%' or co_pilot_id like '${PFX}%';`,
  `delete from sorties where squadron_id in (select id from squadrons where name like '${PFX}%');`,
  `delete from leaves where pilot_id like '${PFX}%';`,
  `delete from unavailable where pilot_id like '${PFX}%';`,
  `delete from notams where squadron_id in (select id from squadrons where name like '${PFX}%');`,
  `delete from alerts where squadron_id in (select id from squadrons where name like '${PFX}%');`,
  `delete from xpc_messages where from_pc_id like '${PFX}%' or to_pc_id like '${PFX}%';`,
  `delete from xpc_pending where hosting_squadron_id like '${PFX}%' or home_squadron_id like '${PFX}%';`,
  `delete from xpc_schedule_shares where origin_squadron_id like '${PFX}%' or id like '${PFX}%';`,
  `delete from xpc_squadron_snapshot where squadron_id like '${PFX}%' or ops_pc_id like '${PFX}%';`,
  `delete from xpc_user_pcs where pc_id like '${PFX}%';`,
  `delete from xpc_pair_links where a_pc_id like '${PFX}%' or b_pc_id like '${PFX}%';`,
  `delete from xpc_registry where id like '${PFX}%';`,
  `delete from pilots where id like '${PFX}%';`,
  `delete from users where username like '${PFX}%';`,
  `delete from squadrons where name like '${PFX}%';`,
  `delete from wings where name like '${PFX}%';`,
  `delete from bases where name like '${PFX}%';`,
];
for (const s of stmts) {
  const r = await sql(s);
  console.log("ok:", s.slice(0, 80));
}
import { createClient } from "@supabase/supabase-js";
const sr = createClient(SUPA_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: list } = await sr.auth.admin.listUsers({ page: 1, perPage: 1000 });
let cleaned = 0;
for (const u of list?.users || []) {
  if ((u.email || "").includes("aud_ops_") || (u.email || "").startsWith("aud_ops")) {
    await sr.auth.admin.deleteUser(u.id);
    cleaned++;
    console.log("deleted auth user:", u.email);
  }
}
console.log("Cleaned", cleaned, "auth users");
