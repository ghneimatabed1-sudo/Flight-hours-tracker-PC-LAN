// Edge function: provision-user
// Creates a Supabase auth user for a new deputy ops officer in the caller's
// squadron and inserts the corresponding row in public.users. Must be called
// by an authenticated user whose JWT carries app_metadata.squadron_id and
// role 'ops' or 'admin'. The auth admin API requires the service role key,
// so this work cannot run from the browser directly.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface Body {
  username: string;
  password: string;
  displayName?: string;
  role?: "ops" | "deputy";
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("authorization");
  if (!authHeader) return json({ error: "missing_auth" }, 401);

  // Identify the caller from their JWT and read their squadron_id claim.
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: caller, error: callerErr } = await callerClient.auth.getUser();
  if (callerErr || !caller.user) return json({ error: "unauthorized" }, 401);

  const meta = (caller.user.app_metadata ?? {}) as { squadron_id?: string; role?: string; squadron_number?: string };
  const squadronId = meta.squadron_id;
  if (!squadronId) return json({ error: "no_squadron_in_token" }, 403);

  // Strict allowlist: caller must have a role claim and it must be ops/admin/superadmin.
  const callerRole = meta.role;
  if (!callerRole || !["ops", "admin", "superadmin"].includes(callerRole)) {
    return json({ error: "forbidden" }, 403);
  }

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const { username, password, displayName } = body;
  if (!username || !password || password.length < 8) {
    return json({ error: "invalid_input" }, 400);
  }
  // Force created role to deputy unless caller is admin/superadmin and explicitly asked otherwise.
  const requestedRole = body.role ?? "deputy";
  let createdRole: "ops" | "deputy" = "deputy";
  if (requestedRole === "ops" && (callerRole === "admin" || callerRole === "superadmin")) {
    createdRole = "ops";
  }

  // Service-role client to actually create the auth user and the public row.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Look up the squadron number so the synthesized email matches the format
  // the client login flow uses: `${username}@${squadronNumber}.rjaf.local`.
  const { data: sqRow } = await admin.from("squadrons").select("number").eq("id", squadronId).single();
  const squadronNumber = (sqRow?.number ?? meta.squadron_number ?? "rjaf").toString().toLowerCase();
  const email = `${username}@${squadronNumber}.rjaf.local`;

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { squadron_id: squadronId, squadron_number: squadronNumber, role: createdRole },
    user_metadata: { username, display_name: displayName ?? username },
  });
  if (createErr || !created.user) {
    return json({ error: "create_failed", detail: createErr?.message }, 400);
  }

  const { data: row, error: insertErr } = await admin.from("users").insert({
    id: created.user.id,
    squadron_id: squadronId,
    username,
    display_name: displayName ?? username,
    role: createdRole,
  }).select().single();
  if (insertErr) {
    // Best-effort rollback of the auth user if the public row insert failed.
    await admin.auth.admin.deleteUser(created.user.id).catch(() => {});
    return json({ error: "insert_failed", detail: insertErr.message }, 400);
  }

  await admin.from("audit_log").insert({
    squadron_id: squadronId,
    type: "user_provisioned",
    actor: caller.user.id,
    detail: { username, role: createdRole, email },
  });

  return json({ ok: true, user: row });
});
