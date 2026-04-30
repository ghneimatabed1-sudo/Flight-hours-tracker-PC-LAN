// Supabase Edge Function: unit-claim-device
//
// Task #299 (review-pass). Final step of the Join → Approve → Bind
// flow. Called by the joining laptop AFTER its status poll shows
// status='approved'. The laptop POSTs:
//   { requestId, claimToken, password }
// where:
//   • requestId   — the device_request id it has been polling
//   • claimToken  — random uuid the laptop generated at JoinSetup time
//                   and stored on the request row alongside
//                   sha256(password)
//   • password    — the laptop's chosen plaintext password, held only
//                   in localStorage until this round-trip.
//
// We verify (a) the request is approved + claim_token matches +
// claim_consumed_at IS NULL, (b) sha256(password) matches the stored
// password_sha256 hash, then call auth.admin.updateUserById to set
// the real password and mark the claim consumed. The joining laptop
// then signs in directly with its own remembered password.
//
// Net: at no point does the database hold the user's plaintext
// password (it only ever sees the SHA-256). The plaintext crosses
// the wire exactly twice — once on JoinSetup (just to compute the
// hash on the laptop side) and once on this call (TLS-encrypted in
// transit, never persisted).

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

async function sha256Hex(text: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time string compare to avoid timing attacks on the claim
// token comparison.
function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

interface Body {
  requestId?: string;
  claimToken?: string;
  password?: string;
}

interface ClaimRow {
  id: string;
  status: string;
  claim_token: string | null;
  claim_consumed_at: string | null;
  password_sha256: string | null;
  supabase_email: string | null;
  member_id: string | null;
  device_id: string | null;
}

// @ts-ignore Deno
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ ok: false, error: "method_not_allowed" }, 405);

  // @ts-ignore Deno
  const url = Deno.env.get("SUPABASE_URL");
  // @ts-ignore Deno
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    return reply({ ok: false, error: "server_misconfigured" }, 503);
  }

  let body: Body;
  try { body = await req.json(); }
  catch { return reply({ ok: false, error: "bad_json" }, 400); }

  const requestId = (body.requestId ?? "").trim();
  const claimToken = (body.claimToken ?? "").trim();
  const password = body.password ?? "";
  if (!requestId || !claimToken || !password) {
    return reply({ ok: false, error: "missing_fields" }, 400);
  }
  if (password.length < 8) {
    return reply({ ok: false, error: "password_too_short" }, 400);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: row, error: rowErr } = await admin
    .from("device_requests")
    .select("id, status, claim_token, claim_consumed_at, password_sha256, supabase_email, member_id, device_id")
    .eq("id", requestId)
    .maybeSingle<ClaimRow>();
  if (rowErr) return reply({ ok: false, error: "lookup_failed", detail: rowErr.message }, 500);
  if (!row) return reply({ ok: false, error: "request_not_found" }, 404);
  if (row.status !== "approved") return reply({ ok: false, error: "not_approved" }, 409);
  if (!row.claim_token || !ctEqual(claimToken, row.claim_token)) {
    return reply({ ok: false, error: "claim_token_mismatch" }, 403);
  }
  if (row.claim_consumed_at) {
    return reply({ ok: false, error: "claim_already_consumed" }, 409);
  }
  if (!row.password_sha256) {
    return reply({ ok: false, error: "request_corrupt" }, 500);
  }
  const suppliedHash = await sha256Hex(password);
  if (!ctEqual(suppliedHash, row.password_sha256)) {
    return reply({ ok: false, error: "password_mismatch" }, 403);
  }
  if (!row.supabase_email || !row.member_id) {
    return reply({ ok: false, error: "request_not_bound" }, 409);
  }

  // Find the auth user via the unit_members.auth_user_id binding (set
  // by unit_complete_approval inside the approve flow).
  const { data: memberRow, error: memberErr } = await admin
    .from("unit_members")
    .select("auth_user_id")
    .eq("id", row.member_id)
    .maybeSingle<{ auth_user_id: string | null }>();
  if (memberErr) return reply({ ok: false, error: "member_lookup_failed", detail: memberErr.message }, 500);
  if (!memberRow?.auth_user_id) return reply({ ok: false, error: "member_unbound" }, 409);

  const { error: updErr } = await admin.auth.admin.updateUserById(memberRow.auth_user_id, {
    password,
    email_confirm: true,
  });
  if (updErr) {
    return reply({ ok: false, error: "user_update_failed", detail: updErr.message }, 500);
  }

  const { error: markErr } = await admin.rpc("unit_mark_claim_consumed", { p_request_id: requestId });
  if (markErr) {
    return reply({ ok: false, error: "mark_failed", detail: markErr.message }, 500);
  }

  return reply({ ok: true, supabaseEmail: row.supabase_email });
});
