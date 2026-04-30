// Supabase Edge Function: notify-currency-expiry
//
// Invoked daily (via pg_cron + pg_net or any external scheduler). For every
// pilot with push reminders enabled, it computes days remaining for each of
// their five currencies (Day / Night / IRT / Medical / Sim), checks whether
// any pilot-configured threshold matches today, and fires an Expo push
// notification — once per (pilot, currency, expiry, threshold) so the same
// reminder cannot double-send.
//
// Deploy with:
//   supabase functions deploy notify-currency-expiry
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// @ts-ignore Deno provided by the Edge runtime
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

const CURRENCY_KEYS = ["day", "night", "irt", "medical", "sim"] as const;
type CurrencyKey = (typeof CURRENCY_KEYS)[number];

const LABELS: Record<CurrencyKey, string> = {
  day: "Day currency",
  night: "Night currency",
  irt: "IRT",
  medical: "Medical",
  sim: "Simulator",
};

interface PrefRow {
  pilot_id: string;
  thresholds: Record<string, number[]> | null;
  expo_push_token: string | null;
}

interface PilotRow {
  id: string;
  data: { expiry?: Record<string, string | null> } | null;
}

interface PendingPush {
  pilotId: string;
  currencyKey: CurrencyKey;
  expiryDate: string; // YYYY-MM-DD
  thresholdDays: number;
  daysRemaining: number;
  expoPushToken: string;
}

// Days between two YYYY-MM-DD dates, treating both as UTC midnight so DST
// shifts cannot bump the count by ±1.
function daysBetween(today: Date, expiry: string): number | null {
  const parts = expiry.split("-");
  if (parts.length !== 3) return null;
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return null;
  }
  const exp = Date.UTC(y, m - 1, d);
  const t = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate()
  );
  return Math.floor((exp - t) / 86_400_000);
}

function bodyFor(label: string, days: number): { title: string; body: string } {
  if (days <= 0) {
    return {
      title: `${label} expires today`,
      body: `Your ${label.toLowerCase()} expires today. Contact your operations officer.`,
    };
  }
  if (days === 1) {
    return {
      title: `${label} expires tomorrow`,
      body: `Your ${label.toLowerCase()} expires in 1 day.`,
    };
  }
  return {
    title: `${label} expires in ${days} days`,
    body: `Heads up — your ${label.toLowerCase()} is due for renewal in ${days} days.`,
  };
}

interface ExpoPushTicket {
  status?: string;
  id?: string;
  message?: string;
  details?: { error?: string };
}

async function sendExpoPushBatch(
  messages: {
    to: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
  }[]
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
  if (!res.ok) {
    throw new Error(`expo_push_failed:${res.status}`);
  }
  const json = (await res.json()) as { data?: ExpoPushTicket[] };
  return json.data ?? [];
}

Deno.serve(async (_req: Request) => {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    return new Response(
      JSON.stringify({ ok: false, error: "server_misconfigured" }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Pull every pilot with reminders enabled and a usable Expo push token.
  const { data: prefs, error: prefsErr } = await admin
    .from("pilot_reminder_prefs")
    .select("pilot_id, thresholds, expo_push_token")
    .eq("push_enabled", true)
    .not("expo_push_token", "is", null);
  if (prefsErr) {
    return new Response(
      JSON.stringify({ ok: false, error: "prefs_query_failed" }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
  const prefRows = (prefs ?? []) as PrefRow[];
  if (prefRows.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, candidates: 0, sent: 0 }),
      { headers: { "content-type": "application/json" } }
    );
  }

  // 2. Fetch matching pilot rows in one batch.
  const pilotIds = prefRows.map((p) => p.pilot_id);
  const { data: pilots, error: pilotsErr } = await admin
    .from("pilots")
    .select("id, data")
    .in("id", pilotIds);
  if (pilotsErr) {
    return new Response(
      JSON.stringify({ ok: false, error: "pilots_query_failed" }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
  const pilotById = new Map<string, PilotRow>();
  for (const p of (pilots ?? []) as PilotRow[]) pilotById.set(p.id, p);

  // 3. Build the list of (pilot, currency, threshold) candidates that match
  //    today's days-remaining count.
  const today = new Date();
  const candidates: PendingPush[] = [];
  for (const pref of prefRows) {
    const pilot = pilotById.get(pref.pilot_id);
    if (!pilot) continue;
    const expiryMap = pilot.data?.expiry ?? {};
    const thresholdMap = pref.thresholds ?? {};
    for (const key of CURRENCY_KEYS) {
      const expiry = expiryMap[key];
      const list = thresholdMap[key];
      if (!expiry || !Array.isArray(list) || list.length === 0) continue;
      const days = daysBetween(today, expiry);
      if (days === null) continue;
      // Match exactly so each threshold fires once on its day. (The dedupe
      // table prevents double-fires if cron runs twice on the same date.)
      for (const raw of list) {
        const threshold = Number(raw);
        if (!Number.isFinite(threshold)) continue;
        if (threshold === days) {
          candidates.push({
            pilotId: pref.pilot_id,
            currencyKey: key,
            expiryDate: expiry,
            thresholdDays: threshold,
            daysRemaining: days,
            expoPushToken: pref.expo_push_token!,
          });
        }
      }
    }
  }

  if (candidates.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, candidates: 0, sent: 0 }),
      { headers: { "content-type": "application/json" } }
    );
  }

  // 4. Filter out anything we already sent (unique constraint also enforces
  //    this, but we want to skip the Expo round-trip for already-sent items).
  const orFilter = candidates
    .map(
      (c) =>
        `and(pilot_id.eq.${c.pilotId},currency_key.eq.${c.currencyKey},expiry_date.eq.${c.expiryDate},threshold_days.eq.${c.thresholdDays})`
    )
    .join(",");
  const { data: existing } = await admin
    .from("pilot_currency_notifications")
    .select("pilot_id, currency_key, expiry_date, threshold_days")
    .or(orFilter);
  const existingKey = new Set(
    (existing ?? []).map(
      (r: {
        pilot_id: string;
        currency_key: string;
        expiry_date: string;
        threshold_days: number;
      }) =>
        `${r.pilot_id}|${r.currency_key}|${r.expiry_date}|${r.threshold_days}`
    )
  );
  const fresh = candidates.filter(
    (c) =>
      !existingKey.has(
        `${c.pilotId}|${c.currencyKey}|${c.expiryDate}|${c.thresholdDays}`
      )
  );
  if (fresh.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, candidates: candidates.length, sent: 0 }),
      { headers: { "content-type": "application/json" } }
    );
  }

  // 5. Send via Expo push, batched (Expo accepts up to 100 per request).
  const messages = fresh.map((c) => {
    const { title, body } = bodyFor(LABELS[c.currencyKey], c.daysRemaining);
    return {
      to: c.expoPushToken,
      title,
      body,
      data: {
        type: "currency_expiry",
        currencyKey: c.currencyKey,
        expiry: c.expiryDate,
        thresholdDays: c.thresholdDays,
        deepLink: "/currency",
      },
      sound: "default",
      priority: "high",
    };
  });

  let sent = 0;
  let failed = 0;
  const goodIndexes: number[] = [];
  for (let i = 0; i < messages.length; i += 100) {
    const slice = messages.slice(i, i + 100);
    let tickets: ExpoPushTicket[] = [];
    try {
      tickets = await sendExpoPushBatch(slice);
    } catch {
      failed += slice.length;
      continue;
    }
    tickets.forEach((ticket, j) => {
      if (ticket.status === "ok") {
        sent += 1;
        goodIndexes.push(i + j);
      } else {
        failed += 1;
      }
    });
  }

  // 6. Record the dedupe rows for everything that Expo accepted. Insert with
  //    ignore-duplicates semantics so concurrent cron runs cannot collide.
  if (goodIndexes.length > 0) {
    const rows = goodIndexes.map((idx) => ({
      pilot_id: fresh[idx].pilotId,
      currency_key: fresh[idx].currencyKey,
      expiry_date: fresh[idx].expiryDate,
      threshold_days: fresh[idx].thresholdDays,
    }));
    await admin
      .from("pilot_currency_notifications")
      .upsert(rows, {
        onConflict: "pilot_id,currency_key,expiry_date,threshold_days",
        ignoreDuplicates: true,
      });
  }

  return new Response(
    JSON.stringify({
      ok: true,
      candidates: candidates.length,
      fresh: fresh.length,
      sent,
      failed,
    }),
    { headers: { "content-type": "application/json" } }
  );
});
