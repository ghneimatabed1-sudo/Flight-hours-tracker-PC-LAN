// Supabase Edge Function: notify-alert
//
// Invoked by the dashboard immediately after a Squadron / Flight Commander
// publishes a new pilot alert (see useCreateAlert in squadron-data.ts). For
// every pilot in the alert's squadron that has a push-notifications-enabled
// device, it fires an Expo push so the alert lands on their phone within
// seconds — no need for the pilot to open the app.
//
// Body (POST JSON): { alertId: string }
//
// Deploy with:
//   supabase functions deploy notify-alert
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

  let body: { alertId?: string } = {};
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: "bad_json" }),
      { status: 400, headers: { ...CORS_HEADERS, "content-type": "application/json" } },
    );
  }
  const alertId = body.alertId;
  if (!alertId) {
    return new Response(
      JSON.stringify({ ok: false, error: "missing_alert_id" }),
      { status: 400, headers: { ...CORS_HEADERS, "content-type": "application/json" } },
    );
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Resolve the alert and the squadron it belongs to.
  const { data: alertRow, error: alertErr } = await admin
    .from("alerts")
    .select("id, squadron_id, body, author, posted_at, priority")
    .eq("id", alertId)
    .single();
  if (alertErr || !alertRow) {
    return new Response(
      JSON.stringify({ ok: false, error: "alert_not_found" }),
      { status: 404, headers: { ...CORS_HEADERS, "content-type": "application/json" } },
    );
  }

  // 2. Pull every pilot in that squadron that has a push token enrolled.
  //    pilot_reminder_prefs is keyed by pilot_id; we join through pilots so
  //    we can scope by squadron without leaking other squadrons' tokens.
  const { data: pilots, error: pilotsErr } = await admin
    .from("pilots")
    .select("id")
    .eq("squadron_id", alertRow.squadron_id);
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

  // 3. Compose one push per device. Title = first ~40 chars of the body so
  //    it's readable on the lock screen; full body in the body field. Tap
  //    deep-links to the in-app Alerts tab. Higher-priority alerts get a
  //    coloured prefix so they stand out on the lock screen even before
  //    the user opens the app.
  const fullText = String(alertRow.body ?? "").trim();
  const pri = String(alertRow.priority ?? "normal");
  const prefix =
    pri === "urgent" ? "🔴 VERY HIGH — " :
    pri === "medium" ? "🟡 HIGH — " : "";
  const titleBase = fullText.length <= 40 ? fullText : fullText.slice(0, 40).trimEnd() + "…";
  const subtitle = alertRow.author ? `From ${alertRow.author}` : "Squadron alert";
  const title = prefix + (titleBase || subtitle);
  // Map our 3-level priority onto Expo's two-level transport priority so
  // the OS treats critical alerts more aggressively (heads-up banner on
  // Android, Critical Alert sound on iOS where supported).
  const expoPriority: "default" | "high" = pri === "normal" ? "default" : "high";
  const messages = tokens.map((token: string) => ({
    to: token,
    title,
    body: fullText,
    data: {
      type: "squadron_alert",
      alertId: alertRow.id,
      squadronId: alertRow.squadron_id,
      author: alertRow.author ?? null,
      postedAt: alertRow.posted_at ?? null,
      priority: pri,
      deepLink: "/alerts",
    },
    sound: "default",
    priority: expoPriority,
  }));

  // 4. Send in batches of 100 (Expo's documented limit per request).
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
