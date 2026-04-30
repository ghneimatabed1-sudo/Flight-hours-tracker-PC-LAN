// Supabase Edge Function: notify-notam
//
// Invoked by the dashboard immediately after a Squadron / Flight Commander
// publishes a new NOTAM (see useCreateNotam in squadron-data.ts). For every
// pilot in the NOTAM's squadron that has a push-notifications-enabled
// device, it fires an Expo push so the advisory lands on their phone
// within seconds — identical fan-out pattern to notify-alert but with a
// different title/body formatting and deep link.
//
// Body (POST JSON): { notamId: string }
//
// Deploy with:
//   supabase functions deploy notify-notam
//
// Environment (auto-injected on Supabase):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

// @ts-nocheck — Deno runtime types are not available in this monorepo.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

interface ExpoPushTicket {
  status?: string;
  id?: string;
  message?: string;
  details?: { error?: string };
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

async function sendExpoPushBatch(
  messages: {
    to: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
    sound?: string;
    priority?: string;
  }[],
): Promise<ExpoPushTicket[]> {
  if (messages.length === 0) return [];
  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      accept: "application/json",
      "accept-encoding": "gzip, deflate",
      "content-type": "application/json",
    },
    body: JSON.stringify(messages),
  });
  if (!res.ok) throw new Error(`expo_push_failed:${res.status}`);
  const json = (await res.json()) as { data?: ExpoPushTicket[] };
  return json.data ?? [];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "method_not_allowed" }),
      { status: 405, headers: { ...CORS_HEADERS, "content-type": "application/json" } },
    );
  }

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    return new Response(
      JSON.stringify({ ok: false, error: "server_misconfigured" }),
      { status: 500, headers: { ...CORS_HEADERS, "content-type": "application/json" } },
    );
  }

  let body: { notamId?: string } = {};
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: "bad_json" }),
      { status: 400, headers: { ...CORS_HEADERS, "content-type": "application/json" } },
    );
  }
  const notamId = body.notamId;
  if (!notamId) {
    return new Response(
      JSON.stringify({ ok: false, error: "missing_notam_id" }),
      { status: 400, headers: { ...CORS_HEADERS, "content-type": "application/json" } },
    );
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Resolve the NOTAM and its squadron.
  const { data: notamRow, error: notamErr } = await admin
    .from("notams")
    .select("id, squadron_id, notam_no, body, posted_on")
    .eq("id", notamId)
    .single();
  if (notamErr || !notamRow) {
    return new Response(
      JSON.stringify({ ok: false, error: "notam_not_found" }),
      { status: 404, headers: { ...CORS_HEADERS, "content-type": "application/json" } },
    );
  }

  // 2. Enumerate pilot ids in that squadron, then pull push-enabled prefs.
  const { data: pilots, error: pilotsErr } = await admin
    .from("pilots")
    .select("id")
    .eq("squadron_id", notamRow.squadron_id);
  if (pilotsErr) {
    return new Response(
      JSON.stringify({ ok: false, error: "pilots_query_failed" }),
      { status: 500, headers: { ...CORS_HEADERS, "content-type": "application/json" } },
    );
  }
  const pilotIds = (pilots ?? []).map((p: { id: string }) => p.id);
  if (pilotIds.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, recipients: 0, sent: 0 }),
      { headers: { ...CORS_HEADERS, "content-type": "application/json" } },
    );
  }

  const { data: prefs, error: prefsErr } = await admin
    .from("pilot_reminder_prefs")
    .select("pilot_id, expo_push_token, push_enabled")
    .in("pilot_id", pilotIds)
    .eq("push_enabled", true)
    .not("expo_push_token", "is", null);
  if (prefsErr) {
    return new Response(
      JSON.stringify({ ok: false, error: "prefs_query_failed" }),
      { status: 500, headers: { ...CORS_HEADERS, "content-type": "application/json" } },
    );
  }
  const tokens = (prefs ?? [])
    .map((p: { expo_push_token: string | null }) => p.expo_push_token)
    .filter((t: string | null): t is string => typeof t === "string" && t.length > 0);
  if (tokens.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, recipients: pilotIds.length, sent: 0 }),
      { headers: { ...CORS_HEADERS, "content-type": "application/json" } },
    );
  }

  // 3. Compose the push. Title = "NOTAM <no>" so the pilot sees at a
  //    glance what it is; body = the advisory text. Tap deep-links to
  //    the Alerts tab (same feed the NOTAM shows up in on mobile).
  const no = String(notamRow.notam_no ?? "").trim();
  const fullText = String(notamRow.body ?? "").trim();
  const title = no ? `NOTAM ${no}` : "New NOTAM";
  const messages = tokens.map((token: string) => ({
    to: token,
    title,
    body: fullText,
    data: {
      type: "notam",
      notamId: notamRow.id,
      notamNo: no || null,
      squadronId: notamRow.squadron_id,
      postedOn: notamRow.posted_on ?? null,
      deepLink: "/alerts",
    },
    sound: "default",
    priority: "high" as const,
  }));

  // 4. Send in batches of 100.
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < messages.length; i += 100) {
    const slice = messages.slice(i, i + 100);
    let tickets: ExpoPushTicket[] = [];
    try {
      tickets = await sendExpoPushBatch(slice);
    } catch {
      failed += slice.length;
      continue;
    }
    for (const t of tickets) {
      if (t.status === "ok") sent += 1;
      else failed += 1;
    }
  }

  return new Response(
    JSON.stringify({ ok: true, recipients: tokens.length, sent, failed }),
    { headers: { ...CORS_HEADERS, "content-type": "application/json" } },
  );
});
