// Supabase Edge Function: unit-super-admin-setup
//
// Task #299 (review-pass). One-shot bootstrap that mints the very
// first super admin for a fresh unit. Only succeeds when no super
// admin currently exists — the predicate is checked twice (once at
// the top of this function for early-exit, once again inside
// `unit_super_admin_complete_setup` under a row-level lock so a race
// between two laptops cannot mint two super admins).
//
// Flow:
//   1) Body: { email, password, displayName, username }
//   2) Verify unit_super_admin_setup_allowed() returns true.
//   3) auth.admin.createUser({ email, password,
//        app_metadata: { role: 'super_admin', tier: 'hq', ... } })
//   4) Mirror into public.users.
//   5) Call unit_super_admin_complete_setup(user_id, username,
//        display_name) — re-checks the predicate inside a tx, inserts
//        the unit_members row.
//
// Anonymous-callable. The setup-allowed predicate IS the gate.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

interface Body {
  email?: string;
  password?: string;
  displayName?: string;
  username?: string;
}

// @ts-ignore Deno
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ ok: false, error: "method_not_allowed" }, 405);

  // @ts-ignore Deno
  const url = Deno.env.get("SUPABASE_URL");
  // @ts-ignore Deno
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return reply({ ok: false, error: "server_misconfigured" }, 503);

  let body: Body;
  try { body = await req.json(); }
  catch { return reply({ ok: false, error: "bad_json" }, 400); }

  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const displayName = (body.displayName ?? "").trim();
  const username = (body.username ?? "").trim().toLowerCase() || email.split("@")[0];

  if (!email || !email.includes("@")) return reply({ ok: false, error: "email_invalid" }, 400);
  if (password.length < 12) return reply({ ok: false, error: "password_too_short" }, 400);
  if (!displayName) return reply({ ok: false, error: "display_name_required" }, 400);
  if (username.length < 2) return reply({ ok: false, error: "username_too_short" }, 400);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: allowed, error: allowErr } = await admin.rpc("unit_super_admin_setup_allowed");
  if (allowErr) return reply({ ok: false, error: "predicate_failed", detail: allowErr.message }, 500);
  if (allowed !== true) return reply({ ok: false, error: "super_admin_already_exists" }, 409);

  const appMeta = {
    role: "super_admin",
    tier: "hq",
    username,
    display_name: displayName,
    squadron_ids: [] as string[],
  };
  const userMeta = { displayName };

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: appMeta,
    user_metadata: userMeta,
  });
  if (createErr || !created.user) {
    return reply({ ok: false, error: "user_create_failed", detail: createErr?.message }, 500);
  }
  const authUserId = created.user.id;

  const { error: mirrorErr } = await admin.from("users").upsert(
    {
      id: authUserId,
      squadron_id: null,
      username,
      display_name: displayName,
      role: "admin",
    },
    { onConflict: "id" },
  );
  if (mirrorErr) {
    return reply({ ok: false, error: "user_mirror_failed", detail: mirrorErr.message }, 500);
  }

  const { data: memberId, error: completeErr } = await admin.rpc(
    "unit_super_admin_complete_setup",
    { p_auth_user_id: authUserId, p_username: username, p_display_name: displayName },
  );
  if (completeErr) {
    // Race: another bootstrap won. Tear down our just-created user so
    // the loser doesn't leave a stranded auth account.
    try { await admin.auth.admin.deleteUser(authUserId); } catch (_) { /* best-effort */ }
    return reply({ ok: false, error: "complete_setup_failed", detail: completeErr.message }, 409);
  }

  return reply({ ok: true, email, memberId });
});
