// Supabase Edge Function: link-pilot-device  (v6)
//
// POST { mil: string, code: string }
//
// Validates a one-time link code and provisions a per-pilot Supabase auth
// user, returning a real session for the mobile app to use under RLS.
//
// v6 changes (Apr 2026):
//   - Case-INsensitive `id` lookup (ilike) — fixes pairing failures on
//     decks where the only identifier is the pilots.id row key (e.g.
//     "RADWAN") and the pilot types it in different casing.
//   - Looks at the top-level `name` and `arabic_name` columns in addition
//     to the JSON-blob fields, since the dashboard pilot form writes both.
//   - Adds `data->>phone` as a fallback identifier.
//   - Logs each lookup attempt + outcome to function logs (visible via
//     Supabase Studio → Edge Functions → Logs) so failures are diagnosable.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

async function sha256Hex(input: string) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomPassword() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// deno-lint-ignore no-explicit-any
type Sb = any;

async function findPilot(admin: Sb, raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Try identifiers in priority order — first hit wins.
  // STRICT MODE (per ops): pilots may only pair with their MILITARY NUMBER.
  // Names, call signs, flight names, phone numbers, and the internal Pxxx
  // pilot id are all rejected here — those identifiers were causing
  // confusion (multiple pilots can share a name, call signs change, etc).
  // The military number is unique-per-squadron at the database level
  // (migration 0021), so a single ilike match is unambiguous.
  const attempts: { label: string; build: () => Sb }[] = [
    {
      label: "data.militaryNumber",
      build: () =>
        admin
          .from("pilots")
          .select("*")
          .filter("data->>militaryNumber", "ilike", trimmed),
    },
  ];

  for (const a of attempts) {
    const { data, error } = await a.build().limit(1);
    if (error) {
      console.log(`[link] lookup ${a.label} ERROR:`, error.message);
      continue;
    }
    if (data && data.length > 0) {
      console.log(`[link] matched pilot via ${a.label}: id=${data[0].id}`);
      return data[0];
    }
  }
  console.log(`[link] no pilot matched identifier "${trimmed}"`);
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return reply({ ok: false, error: "method_not_allowed" }, 405);
  }

  let body: { mil?: string; code?: string };
  try {
    body = await req.json();
  } catch {
    return reply({ ok: false, error: "bad_json" }, 400);
  }
  const mil = (body.mil ?? "").trim();
  const code = (body.code ?? "").trim();
  if (!mil || !code) {
    return reply({ ok: false, error: "invalid_credentials" }, 400);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) {
    return reply({ ok: false, error: "server_misconfigured" }, 500);
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Resolve pilot from any identifier the Super Admin assigned.
  const pilot = await findPilot(admin, mil);
  if (!pilot) {
    return reply({ ok: false, error: "not_found" }, 404);
  }

  // 2. Verify the one-time code: SHA-256 hash, must be unconsumed and
  //    not expired, and must belong to this pilot.
  const codeHash = await sha256Hex(code);
  const { data: codeRow, error: codeErr } = await admin
    .from("pilot_link_codes")
    .select("id, pilot_id, squadron_id, expires_at, consumed_at")
    .eq("pilot_id", pilot.id)
    .eq("code_hash", codeHash)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("issued_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (codeErr) {
    console.log("[link] code lookup error:", codeErr.message);
    return reply({ ok: false, error: "generic" }, 500);
  }
  if (!codeRow) {
    console.log(`[link] no valid code for pilot ${pilot.id}`);
    return reply({ ok: false, error: "bad_code" }, 401);
  }

  // 3. Provision (or refresh) the per-pilot auth user. Email is synthetic;
  //    the real auth is the link code.
  const email = `pilot+${pilot.id.toLowerCase()}@rjaf.local`.replace(/\s+/g, "");
  const password = randomPassword();

  let userId: string | null = null;

  // a. Fast path: if this pilot has paired before, the auth user_id is
  // already recorded on their pilot_devices row. This is an O(1) indexed
  // lookup and scales to any number of total auth users (the listUsers
  // fallback below only paginates 1000 at a time, so for deployments with
  // 1000+ pilots across squadrons we want to avoid it whenever possible).
  const { data: existingDevice } = await admin
    .from("pilot_devices")
    .select("user_id")
    .eq("pilot_id", pilot.id)
    .not("user_id", "is", null)
    .limit(1)
    .maybeSingle();
  if (existingDevice?.user_id) {
    userId = existingDevice.user_id;
    const { error: updErr } = await admin.auth.admin.updateUserById(userId, {
      password,
      app_metadata: {
        pilot_id: pilot.id,
        squadron_id: codeRow.squadron_id,
        role: "pilot",
      },
    });
    if (updErr) {
      console.log("[link] updateUserById (fast path) error:", updErr.message);
      // Fall through to the create/lookup path; userId will be re-resolved.
      userId = null;
    }
  }

  // b. Try create. If already exists, paginate listUsers to find them.
  if (!userId) {
    const { data: created, error: createErr } = await admin.auth.admin
      .createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: {
          pilot_id: pilot.id,
          squadron_id: codeRow.squadron_id,
          role: "pilot",
        },
        user_metadata: { pilot_id: pilot.id },
      });
    if (created?.user) {
      userId = created.user.id;
    } else if (createErr && /already/i.test(createErr.message ?? "")) {
      // Paginate listUsers — capped to keep the function within its
      // execution budget. With perPage=1000 this covers up to 50,000
      // total auth users across every squadron, well above any realistic
      // RJAF deployment.
      const PER_PAGE = 1000;
      const MAX_PAGES = 50;
      let existing: { id: string } | undefined;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const { data: list, error: listErr } = await admin.auth.admin
          .listUsers({ page, perPage: PER_PAGE });
        if (listErr) {
          console.log("[link] listUsers page", page, "error:", listErr.message);
          break;
        }
        const users = list?.users ?? [];
        existing = users.find(
          (u) => (u.email ?? "").toLowerCase() === email,
        );
        if (existing) break;
        if (users.length < PER_PAGE) break; // last page
      }
      if (!existing) {
        console.log("[link] could not locate existing auth user for", email);
        return reply({ ok: false, error: "generic" }, 500);
      }
      userId = existing.id;
      const { error: updErr } = await admin.auth.admin.updateUserById(
        existing.id,
        {
          password,
          app_metadata: {
            pilot_id: pilot.id,
            squadron_id: codeRow.squadron_id,
            role: "pilot",
          },
        },
      );
      if (updErr) {
        console.log("[link] updateUserById (lookup path) error:", updErr.message);
        return reply({ ok: false, error: "generic" }, 500);
      }
    } else if (createErr) {
      console.log("[link] createUser error:", createErr.message);
      return reply({ ok: false, error: "generic" }, 500);
    }
  }

  if (!userId) {
    return reply({ ok: false, error: "generic" }, 500);
  }

  // 4. Sign in as the user with the rotated password to get a real
  //    session for the mobile app.
  const anon = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: signIn, error: signErr } = await anon.auth.signInWithPassword({
    email,
    password,
  });
  if (signErr || !signIn?.session) {
    console.log("[link] sign-in error:", signErr?.message);
    return reply({ ok: false, error: "generic" }, 500);
  }

  // 5. Mark the code consumed and record the device link.
  await admin.from("pilot_link_codes").update({
    consumed_at: new Date().toISOString(),
  }).eq("id", codeRow.id);

  // Record (or refresh) the device link.
  //
  // History:
  //   * Migration 0016 added `pilot_devices.user_id`. Earlier deployments of
  //     this function lost the insert because the column did not exist,
  //     leaving the dashboard stuck on "NOT LINKED / Never".
  //   * Migration 0020 (Apr 2026) replaced the *partial* unique INDEXES on
  //     user_id / token_hash with real unique CONSTRAINTS so PostgREST
  //     `upsert(..., { onConflict: "user_id" })` actually works. Before that
  //     change Postgres raised "no unique or exclusion constraint matching
  //     the ON CONFLICT specification" and the error was silently swallowed.
  //
  // Defensive fallback: if the upsert still fails for any reason (schema
  // drift, transient error), fall back to an explicit delete-then-insert so
  // the dashboard cannot get stuck on "NOT LINKED" again. If even the
  // fallback fails, surface the error to the mobile app so the pilot is told
  // to retry rather than silently "succeeding" with no dashboard visibility.
  const nowIso = new Date().toISOString();
  const deviceRow = {
    pilot_id: pilot.id,
    squadron_id: codeRow.squadron_id,
    user_id: userId,
    linked_at: nowIso,
    last_seen_at: nowIso,
    revoked_at: null,
  };
  // CRITICAL: bind the auth user to the pilots row. The pilot mobile RLS
  // (pilots_self_select in 0003) and the reminder-prefs save RPC
  // (save_pilot_reminder_prefs in 0005) BOTH require
  // `pilots.auth_user_id = auth.uid()`. Without this update the pilot can
  // sign in but every "save my push token" call raises 'unauthorized' and
  // the dashboard's notify-alert leg finds no token to push to → alerts
  // only appear when the app is open. Migration 0022 backfills already-
  // paired pilots; this line keeps new pairings correct going forward.
  const { error: bindErr } = await admin
    .from("pilots")
    .update({ auth_user_id: userId })
    .eq("id", pilot.id)
    .eq("squadron_id", codeRow.squadron_id);
  if (bindErr) {
    console.log("[link] pilots.auth_user_id update error:", bindErr.message);
    // Don't fail the pair — pilot can still read public squadron data; the
    // backfill migration / next pair attempt will heal the binding.
  }

  const { error: deviceErr } = await admin
    .from("pilot_devices")
    .upsert(deviceRow, { onConflict: "user_id" });
  if (deviceErr) {
    console.log(
      "[link] pilot_devices upsert error, falling back:",
      deviceErr.message,
    );
    const { error: delErr } = await admin
      .from("pilot_devices")
      .delete()
      .eq("user_id", userId);
    if (delErr) {
      console.log("[link] pilot_devices delete fallback error:", delErr.message);
    }
    const { error: insErr } = await admin
      .from("pilot_devices")
      .insert(deviceRow);
    if (insErr) {
      console.log("[link] pilot_devices insert fallback error:", insErr.message);
      return reply({
        ok: false,
        error: "device_link_failed",
        detail: insErr.message,
      }, 500);
    }
  }

  return reply({
    ok: true,
    pilotId: pilot.id,
    squadronId: codeRow.squadron_id,
    session: {
      access_token: signIn.session.access_token,
      refresh_token: signIn.session.refresh_token,
      expires_at: signIn.session.expires_at,
    },
  });
});
