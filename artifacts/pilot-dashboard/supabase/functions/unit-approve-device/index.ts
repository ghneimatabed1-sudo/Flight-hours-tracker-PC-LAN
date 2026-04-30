// Supabase Edge Function: unit-approve-device
//
// Task #299 (review-pass rework). Approves a pending join request by
// creating an auth.users row and binding it to the unit_members +
// devices rows reserved by `unit_reserve_approval`.
//
// Critical security change vs. the original 0069 design: this function
// no longer reads or stores the joining laptop's chosen password. The
// joining laptop holds its password locally and exchanges it for a
// real auth.users password later via the separate `unit-claim-device`
// function (see migration 0075 for the full rationale). On approve we
// stamp a long random throw-away password on the new user — it is
// never surfaced to anyone and is overwritten the moment the joining
// laptop runs the claim step.
//
// Security:
//   • Caller must present a Bearer JWT with app_metadata.role =
//     'super_admin' (or the legacy admin+hq combo accepted by
//     xpc_is_super_admin).
//   • The function calls back into Postgres via SUPABASE_SERVICE_ROLE_KEY
//     so it can complete the approval without RLS interference.
//     `unit_complete_approval` enforces super-admin OR service-role
//     explicitly via current_setting('role').

import { createClient, type User as AuthUser } from "https://esm.sh/@supabase/supabase-js@2";

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

function sqnSlug(s: string): string {
  return (s || "unit").toLowerCase().replace(/[^a-z0-9]/g, "");
}

interface Body {
  requestId?: string;
}

interface ReservedRequestRow {
  id: string;
  status: string;
  member_id: string | null;
  device_id: string | null;
  username: string;
  display_name: string;
  requested_role: string;
  supabase_email: string | null;
}

interface MemberRow {
  id: string;
  role: string;
  tier: string;
  squadron_allow_list: string[] | null;
  primary_squadron_id: string | null;
  username: string;
  display_name: string;
}

// Cryptographically random throw-away password.
// Must satisfy stricter GoTrue password policies (upper/lower/digit/symbol).
// Replaced by the joining laptop's real password on the claim step.
function randomPlaceholderPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%^&*()-_=+[]{}";
  const all = upper + lower + digits + symbols;

  const pick = (charset: string): string => {
    const bytes = new Uint8Array(1);
    crypto.getRandomValues(bytes);
    return charset[bytes[0] % charset.length];
  };

  const chars = [
    pick(upper),
    pick(lower),
    pick(digits),
    pick(symbols),
  ];
  for (let i = 0; i < 20; i += 1) chars.push(pick(all));

  // Fisher-Yates shuffle so required-class chars are not predictable.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const bytes = new Uint8Array(1);
    crypto.getRandomValues(bytes);
    const j = bytes[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

async function findAuthUserIdByEmail(admin: ReturnType<typeof createClient>, email: string): Promise<string | null> {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return null;
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) break;
    const users = data?.users ?? [];
    if (!users.length) break;
    const match = users.find((u: AuthUser) => (u.email ?? "").toLowerCase() === wanted);
    if (match) return match.id;
  }
  return null;
}

// @ts-ignore Deno
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ ok: false, error: "method_not_allowed" }, 405);

  // @ts-ignore Deno
  const url = Deno.env.get("SUPABASE_URL");
  // @ts-ignore Deno
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // @ts-ignore Deno
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !serviceKey || !anonKey) {
    return reply({ ok: false, error: "server_misconfigured" }, 503);
  }

  // ── 1. Verify the caller is the super admin ─────────────────────────────
  const callerJwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!callerJwt) return reply({ ok: false, error: "unauthorized" }, 401);

  const callerClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${callerJwt}` } },
    auth: { persistSession: false },
  });
  const { data: roleProbe, error: roleProbeErr } = await callerClient.rpc("xpc_is_super_admin");
  if (roleProbeErr) {
    return reply({ ok: false, error: "role_probe_failed", detail: roleProbeErr.message }, 401);
  }
  if (!roleProbe) {
    return reply({ ok: false, error: "super_admin_required" }, 403);
  }

  // ── 2. Parse body ─────────────────────────────────────────────────────
  let body: Body;
  try { body = await req.json(); }
  catch { return reply({ ok: false, error: "bad_json" }, 400); }
  const requestId = (body.requestId ?? "").trim();
  if (!requestId) return reply({ ok: false, error: "missing_request_id" }, 400);

  // ── 3. Read the reserved request row (using service role) ─────────────
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: reqRow, error: reqRowErr } = await admin
    .from("device_requests")
    .select("id, status, member_id, device_id, username, display_name, requested_role, supabase_email")
    .eq("id", requestId)
    .maybeSingle<ReservedRequestRow>();
  if (reqRowErr) {
    return reply({ ok: false, error: "request_lookup_failed", detail: reqRowErr.message }, 500);
  }
  if (!reqRow) return reply({ ok: false, error: "request_not_found" }, 404);
  if (reqRow.status !== "approved") {
    return reply({ ok: false, error: "request_not_reserved", detail: `status=${reqRow.status}` }, 409);
  }
  if (!reqRow.member_id) {
    return reply({ ok: false, error: "request_not_reserved" }, 409);
  }
  // Idempotent retry — already bound.
  if (reqRow.supabase_email) {
    return reply({
      ok: true,
      idempotent: true,
      supabaseEmail: reqRow.supabase_email,
      memberId: reqRow.member_id,
      deviceId: reqRow.device_id,
    });
  }

  // ── 4. Read the unit_members row to get role/tier/squadron list ──────
  const { data: memberRow, error: memberRowErr } = await admin
    .from("unit_members")
    .select("id, role, tier, squadron_allow_list, primary_squadron_id, username, display_name")
    .eq("id", reqRow.member_id)
    .maybeSingle<MemberRow>();
  if (memberRowErr || !memberRow) {
    return reply({ ok: false, error: "member_lookup_failed", detail: memberRowErr?.message }, 500);
  }

  // ── 5. Create the auth.users row with a random throw-away password ──
  const sqnHint = sqnSlug(memberRow.squadron_allow_list?.[0] ?? "unit");
  const email = `${memberRow.username}@${sqnHint}.unit.local`;
  const placeholderPassword = randomPlaceholderPassword();
  const appMeta: Record<string, unknown> = {
    role: memberRow.role,
    tier: memberRow.tier,
    username: memberRow.username,
    display_name: memberRow.display_name,
    squadron_ids: memberRow.squadron_allow_list ?? [],
  };
  if (memberRow.primary_squadron_id) {
    appMeta.squadron_id = memberRow.primary_squadron_id;
  }
  const userMeta = { displayName: memberRow.display_name };

  let authUserId: string | null = null;
  try {
    authUserId = await findAuthUserIdByEmail(admin, email);
  } catch (_) { /* listUsers not strictly required */ }

  if (authUserId) {
    const { error: updErr } = await admin.auth.admin.updateUserById(authUserId, {
      password: placeholderPassword,
      app_metadata: appMeta,
      user_metadata: userMeta,
      email_confirm: true,
      ban_duration: "none",
    });
    if (updErr) {
      return reply({ ok: false, error: "user_update_failed", detail: updErr.message }, 500);
    }
  } else {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password: placeholderPassword,
      email_confirm: true,
      app_metadata: appMeta,
      user_metadata: userMeta,
    });
    if (createErr || !created.user) {
      const msg = (createErr?.message ?? "").toLowerCase();
      const conflict = msg.includes("already") || msg.includes("exists") || msg.includes("registered");
      if (!conflict) {
        return reply({ ok: false, error: "user_create_failed", detail: createErr?.message }, 500);
      }
      const existingId = await findAuthUserIdByEmail(admin, email);
      if (!existingId) {
        return reply({ ok: false, error: "user_create_failed", detail: createErr?.message }, 500);
      }
      authUserId = existingId;
      const { error: updErr } = await admin.auth.admin.updateUserById(authUserId, {
        password: placeholderPassword,
        app_metadata: appMeta,
        user_metadata: userMeta,
        email_confirm: true,
        ban_duration: "none",
      });
      if (updErr) {
        return reply({ ok: false, error: "user_update_failed", detail: updErr.message }, 500);
      }
    } else {
      authUserId = created.user.id;
    }
  }

  // ── 6. Mirror into public.users so audit-log joins surface the name ──
  const publicRole = memberRow.role === "super_admin" ? "admin" : memberRow.role;
  const { error: mirrorErr } = await admin.from("users").upsert(
    {
      id: authUserId,
      squadron_id: memberRow.primary_squadron_id,
      username: memberRow.username,
      display_name: memberRow.display_name,
      role: publicRole,
    },
    { onConflict: "id" },
  );
  if (mirrorErr) {
    return reply({ ok: false, error: "user_mirror_failed", detail: mirrorErr.message }, 500);
  }

  // ── 7. Bind auth_user_id (no password param — see migration 0075) ─────
  const { error: completeErr } = await admin.rpc("unit_complete_approval", {
    p_request_id: requestId,
    p_auth_user_id: authUserId,
    p_supabase_email: email,
  });
  if (completeErr) {
    return reply({ ok: false, error: "complete_approval_failed", detail: completeErr.message }, 500);
  }

  return reply({
    ok: true,
    supabaseEmail: email,
    memberId: memberRow.id,
    deviceId: reqRow.device_id,
  });
});
