// Supabase Edge Function: manage-reminder-schedule
//
// Lets the dashboard's super-admin panel turn the daily currency-expiry
// reminder cron on or off in one click. The schedule itself runs inside
// Postgres (pg_cron + pg_net), but it needs the project's own
// SUPABASE_SERVICE_ROLE_KEY pasted into a `net.http_post` Authorization
// header. We don't want to ship that key into the browser, so this
// function reads it from its own env and forwards it to the
// SECURITY DEFINER helpers added in 0007_reminder_schedule.sql.
//
// Authorization model:
//   The dashboard's super-admin login already happens in `super-admin-2fa`
//   but issues no Supabase JWT. To gate this endpoint without exposing
//   reads, every action requires a short-lived HMAC session token bound
//   to the super-admin username.  The client first calls action="session"
//   with { username, password, code } — the same triple that
//   super-admin-2fa accepts — and receives a 30-minute token. All other
//   actions require that token in the request body.
//
//   Failed TOTP attempts are persisted into super_admin_2fa.failed_attempts
//   with the same 5-strike, 5-minute lockout policy used by the login
//   function, so a leaked password cannot be paired with online TOTP
//   brute-force attempts here either.
//
// Actions (POST { action, ... }):
//   - "session" { username, password, code } → { ok, token, expiresAt }
//   - "status"  { token }                     → { ok, status }
//   - "log"     { token }                     → { ok, log }
//   - "enable"  { token, cron? }              → { ok, result }
//   - "disable" { token }                     → { ok, result }
//   - "run-now" { token }                     → { ok, result } — invokes
//       notify-currency-expiry once with the service-role bearer so ops can
//       verify the wiring without waiting for the next cron tick.
//
// Deploy:
//   supabase functions deploy manage-reminder-schedule --no-verify-jwt
// Required secrets (already shared with super-admin-2fa):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   SUPER_ADMIN_PASSWORD_HASH, CHALLENGE_SECRET

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// @ts-ignore Deno provided by Edge runtime
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALLOWED_USERNAME = "admin";
const SCHEDULE_NAME = "notify-currency-expiry-daily";
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SESSION_TTL_MS = 30 * 60_000;            // 30 min session
const TOTP_LOCKOUT_THRESHOLD = 5;
const TOTP_LOCKOUT_MS = 5 * 60_000;
const PW_FAIL_THRESHOLD = 10;
const PW_FAIL_WINDOW_MS = 10 * 60_000;
const PW_LOCKOUT_MS = 15 * 60_000;

// In-memory password-failure throttle, per-username. Same pattern as
// super-admin-2fa: durable TOTP lockout lives in the DB, but the password
// throttle is a warm-instance brake on online brute force.
const pwFails = new Map<string, { count: number; firstAt: number; lockedUntil: number }>();

function reply(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hmacSha256Hex(keyStr: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(keyStr),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  return Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function issueSessionToken(secret: string, username: string): Promise<{ token: string; expiresAt: number }> {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${exp}|${username}`;
  const mac = await hmacSha256Hex(secret, payload);
  return { token: btoa(`${payload}|${mac}`).replace(/=+$/, ""), expiresAt: exp };
}

async function verifySessionToken(secret: string, token: string): Promise<{ ok: boolean; username?: string }> {
  let decoded: string;
  try { decoded = atob(token); } catch { return { ok: false }; }
  const parts = decoded.split("|");
  if (parts.length !== 3) return { ok: false };
  const [expStr, tokUser, mac] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return { ok: false };
  const expected = await hmacSha256Hex(secret, `${expStr}|${tokUser}`);
  if (!timingSafeEq(mac, expected)) return { ok: false };
  return { ok: true, username: tokUser };
}

function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  const out: number[] = [];
  let bits = 0, value = 0;
  for (let i = 0; i < clean.length; i++) {
    const idx = B32_ALPHABET.indexOf(clean[i]);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  const high = Math.floor(counter / 0x1_0000_0000);
  const low = counter >>> 0;
  view.setUint32(0, high);
  view.setUint32(4, low);
  const key = await crypto.subtle.importKey(
    "raw", secret as BufferSource,
    { name: "HMAC", hash: "SHA-1" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const offset = sig[sig.length - 1] & 0x0f;
  const code = ((sig[offset] & 0x7f) << 24)
             | (sig[offset + 1] << 16)
             | (sig[offset + 2] << 8)
             |  sig[offset + 3];
  return (code % 1_000_000).toString().padStart(6, "0");
}

async function verifyTotp(secretB32: string, code: string, windowSteps = 1): Promise<boolean> {
  const clean = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const bytes = base32Decode(secretB32);
  const counter = Math.floor(Date.now() / 30_000);
  for (let w = -windowSteps; w <= windowSteps; w++) {
    if ((await hotp(bytes, counter + w)) === clean) return true;
  }
  return false;
}

interface Body {
  action?: "session" | "status" | "log" | "enable" | "disable" | "run-now";
  username?: string;
  password?: string;
  code?: string;
  token?: string;
  cron?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ ok: false, error: "method_not_allowed" }, 405);

  let body: Body;
  try { body = await req.json(); }
  catch { return reply({ ok: false, error: "bad_json" }, 400); }

  const action = body.action;
  if (!action) return reply({ ok: false, error: "missing_action" }, 400);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const challengeSecret = Deno.env.get("CHALLENGE_SECRET") ?? "";
  if (!url || !serviceKey || !challengeSecret) {
    return reply({ ok: false, error: "server_misconfigured" }, 500);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // ── session: password + TOTP → short-lived HMAC token ────────────────────
  if (action === "session") {
    const username = (body.username ?? "").trim().toLowerCase();
    const password = body.password ?? "";
    const code = (body.code ?? "").trim();
    if (!username || !password || !code) {
      return reply({ ok: false, error: "missing_fields" }, 400);
    }
    if (username !== ALLOWED_USERNAME) {
      return reply({ ok: false, error: "unauthorized" }, 401);
    }

    const expectedHash = (Deno.env.get("SUPER_ADMIN_PASSWORD_HASH") ?? "").toLowerCase();
    if (!expectedHash) return reply({ ok: false, error: "server_misconfigured" }, 500);

    // Password throttle (warm-instance only).
    const now = Date.now();
    const pwFail = pwFails.get(username);
    if (pwFail && pwFail.lockedUntil > now) {
      return reply({ ok: false, error: "locked", lockedUntil: pwFail.lockedUntil }, 429);
    }
    const providedHash = (await sha256Hex(password)).toLowerCase();
    if (!timingSafeEq(providedHash, expectedHash)) {
      const cur = (pwFail && now - pwFail.firstAt < PW_FAIL_WINDOW_MS)
        ? pwFail
        : { count: 0, firstAt: now, lockedUntil: 0 };
      cur.count += 1;
      if (cur.count >= PW_FAIL_THRESHOLD) cur.lockedUntil = now + PW_LOCKOUT_MS;
      pwFails.set(username, cur);
      return reply({ ok: false, error: "unauthorized" }, 401);
    }
    pwFails.delete(username);

    // Persistent TOTP lockout in the same row super-admin-2fa uses.
    const { data: row, error: rowErr } = await admin
      .from("super_admin_2fa")
      .select("secret_b32, enrolled_at, failed_attempts, locked_until")
      .eq("username", username)
      .maybeSingle();
    if (rowErr) return reply({ ok: false, error: "lookup_failed" }, 500);
    if (!row || !row.enrolled_at) return reply({ ok: false, error: "not_enrolled" }, 401);
    if (row.locked_until && new Date(row.locked_until).getTime() > now) {
      return reply({ ok: false, error: "locked" }, 423);
    }

    const totpOk = await verifyTotp(row.secret_b32 as string, code);
    if (!totpOk) {
      const fails = ((row.failed_attempts as number) ?? 0) + 1;
      const lockUntil = fails >= TOTP_LOCKOUT_THRESHOLD
        ? new Date(now + TOTP_LOCKOUT_MS).toISOString()
        : null;
      await admin.from("super_admin_2fa").update({
        failed_attempts: fails,
        locked_until: lockUntil,
        updated_at: new Date().toISOString(),
      }).eq("username", username);
      await admin.from("audit_log").insert({
        squadron_id: null,
        type: "reminders.session.bad_code",
        actor: username,
        detail: { fails },
      }).then(() => {}, () => {});
      return reply({ ok: false, error: lockUntil ? "locked" : "bad_code", fails }, 401);
    }

    // Success: clear failures and mint a session token.
    await admin.from("super_admin_2fa").update({
      failed_attempts: 0,
      locked_until: null,
      last_verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("username", username);

    const { token, expiresAt } = await issueSessionToken(challengeSecret, username);
    return reply({ ok: true, token, expiresAt });
  }

  // ── All other actions require a valid session token. ────────────────────
  const tokenIn = body.token ?? "";
  if (!tokenIn) return reply({ ok: false, error: "missing_token" }, 401);
  const tok = await verifySessionToken(challengeSecret, tokenIn);
  if (!tok.ok || tok.username !== ALLOWED_USERNAME) {
    return reply({ ok: false, error: "bad_token" }, 401);
  }

  if (action === "status") {
    const { data, error } = await admin.rpc("reminder_schedule_status");
    if (error) return reply({ ok: false, error: error.message }, 500);
    return reply({ ok: true, status: data });
  }

  if (action === "log") {
    const { data, error } = await admin.rpc("recent_reminder_log");
    if (error) return reply({ ok: false, error: error.message }, 500);
    return reply({ ok: true, log: data ?? [] });
  }

  if (action === "enable") {
    const cron = (body.cron ?? "0 6 * * *").trim();
    if (!/^[\d\*\/\,\-\s]+$/.test(cron) || cron.split(/\s+/).length !== 5) {
      return reply({ ok: false, error: "bad_cron" }, 400);
    }
    const fnUrl = `${url.replace(/\/$/, "")}/functions/v1/notify-currency-expiry`;
    interface SetScheduleResult {
      ok?: boolean;
      jobid?: number | null;
      schedule?: string | null;
    }
    const { data, error } = await admin.rpc("set_reminder_schedule", {
      p_function_url: fnUrl,
      p_service_key: serviceKey,
      p_cron: cron,
    });
    if (error) return reply({ ok: false, error: error.message }, 500);
    const result = (data ?? {}) as SetScheduleResult;
    await admin.from("audit_log").insert({
      squadron_id: null,
      type: "reminders.schedule.enabled",
      actor: tok.username,
      detail: { schedule: cron, jobid: result.jobid ?? null },
    }).then(() => {}, () => {});
    return reply({ ok: true, result });
  }

  if (action === "run-now") {
    const fnUrl = `${url.replace(/\/$/, "")}/functions/v1/notify-currency-expiry`;
    const startedAt = new Date().toISOString();
    let httpStatus = 0;
    let payload: Record<string, unknown> | null = null;
    let errorMsg: string | null = null;
    try {
      const resp = await fetch(fnUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      httpStatus = resp.status;
      const text = await resp.text();
      try { payload = text ? JSON.parse(text) : null; }
      catch { errorMsg = text.slice(0, 500); }
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
    }
    const endedAt = new Date().toISOString();
    const ok = httpStatus >= 200 && httpStatus < 300 && !!payload?.ok;
    const sent = typeof payload?.sent === "number" ? payload.sent : 0;
    const failed = typeof payload?.failed === "number" ? payload.failed : 0;
    const candidates = typeof payload?.candidates === "number" ? payload.candidates : 0;

    // Persist a row so the dashboard's recent-runs table surfaces this
    // manual invocation alongside the cron-driven runs on next refresh.
    const returnMessage = ok
      ? `manual: sent=${sent}, failed=${failed}, candidates=${candidates}`
      : `manual: ${errorMsg ?? (payload?.error as string | undefined) ?? `http_${httpStatus}`}`;
    await admin.from("reminder_manual_runs").insert({
      started_at: startedAt,
      ended_at: endedAt,
      status: ok ? "succeeded" : "failed",
      return_message: returnMessage,
      actor: tok.username,
    }).then(() => {}, () => {});

    await admin.from("audit_log").insert({
      squadron_id: null,
      type: ok ? "reminders.run_now" : "reminders.run_now.failed",
      actor: tok.username,
      detail: { httpStatus, sent, failed, candidates, error: errorMsg ?? payload?.error ?? null },
    }).then(() => {}, () => {});
    if (!ok) {
      return reply({
        ok: false,
        error: errorMsg ?? (payload?.error as string | undefined) ?? `http_${httpStatus}`,
        httpStatus,
      }, 502);
    }
    return reply({ ok: true, result: { sent, failed, candidates, httpStatus } });
  }

  if (action === "disable") {
    const { data, error } = await admin.rpc("clear_reminder_schedule");
    if (error) return reply({ ok: false, error: error.message }, 500);
    await admin.from("audit_log").insert({
      squadron_id: null,
      type: "reminders.schedule.disabled",
      actor: tok.username,
      detail: { schedule_name: SCHEDULE_NAME },
    }).then(() => {}, () => {});
    return reply({ ok: true, result: data });
  }

  return reply({ ok: false, error: "unknown_action" }, 400);
});
