#!/usr/bin/env node
// Generates `seed.sql` from the same deterministic mock data the in-memory
// preview uses (artifacts/pilot-dashboard/src/lib/mock.ts). Re-run after
// changing the mock data to refresh the SQL fixture:
//
//   node artifacts/pilot-dashboard/supabase/seed/generate-seed.mjs
//
// The generator deliberately mirrors the JS RNG (LCG seed=42) and helper
// shapes from mock.ts rather than importing them, so this script has zero
// build dependencies and can run with plain Node.
//
// Multi-squadron seed: the first squadron is the original "7th Squadron"
// fixture (IDs / license key unchanged for backward compatibility). Three
// additional demo squadrons are generated so Hawk Eye HQ commanders have
// realistic cross-squadron data (overview cards, cross-squadron pilot
// table) the moment the database is seeded. Each squadron uses its own
// RNG seed, pilot-ID prefix, license key, and admin auth user, so data
// never collides across squadrons.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Task #137: production seed.sql is intentionally empty so a fresh
// install runs the in-app Setup Wizard. The generator now writes the
// 4-squadron demo block to seed.demo.sql; reset/reseed scripts that
// want demo data must opt in via the SEED_FILE override.
const OUT = join(HERE, "seed.demo.sql");

// ── Demo squadron roster ──────────────────────────────────────────────────
// pilotPrefix controls the pilot-ID numeric offset so IDs don't collide
// across squadrons: squadron 1 uses P001-P016, squadron 2 P101-P116, etc.
// Each squadron gets its own RNG seed so hours/expiries/sorties differ.
const SQUADRONS = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    number: "7",
    name: "7th Squadron",
    base: "King Abdullah II Air Base",
    licenseKey: "DEMO-RJAF-1234-5678",
    rngSeed: 42,
    pilotPrefix: 0,          // -> P001..P016
    adminUserId: "00000000-0000-0000-0000-0000000000a1",
    adminEmail: "admin@demo.rjaf.local",
    adminPassword: "admin123",
    adminUsername: "ops.lead",
    adminDisplay: "Ops Lead",
    notamPrefix: "N",        // -> N0001..
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    number: "8",
    name: "8th Search & Rescue Squadron",
    base: "King Hussein Air Base",
    licenseKey: "DEMO-RJAF-8SAR-0002",
    rngSeed: 101,
    pilotPrefix: 100,        // -> P101..P116
    adminUserId: "00000000-0000-0000-0000-0000000000a2",
    adminEmail: "admin@8sar.rjaf.local",
    adminPassword: "admin123",
    adminUsername: "ops.8sar",
    adminDisplay: "8SAR Ops Lead",
    notamPrefix: "R",        // -> R0001..
  },
  {
    id: "00000000-0000-0000-0000-000000000003",
    number: "12",
    name: "12th VIP Transport Squadron",
    base: "Marka Air Base",
    licenseKey: "DEMO-RJAF-12VIP-0003",
    rngSeed: 202,
    pilotPrefix: 200,        // -> P201..P216
    adminUserId: "00000000-0000-0000-0000-0000000000a3",
    adminEmail: "admin@12vip.rjaf.local",
    adminPassword: "admin123",
    adminUsername: "ops.12vip",
    adminDisplay: "12VIP Ops Lead",
    notamPrefix: "V",        // -> V0001..
  },
  {
    id: "00000000-0000-0000-0000-000000000004",
    number: "5",
    name: "5th Flight Test Squadron",
    base: "Mafraq Air Base",
    licenseKey: "DEMO-RJAF-5FTS-0004",
    rngSeed: 303,
    pilotPrefix: 300,        // -> P301..P316
    adminUserId: "00000000-0000-0000-0000-0000000000a4",
    adminEmail: "admin@5fts.rjaf.local",
    adminPassword: "admin123",
    adminUsername: "ops.5fts",
    adminDisplay: "5FTS Ops Lead",
    notamPrefix: "T",        // -> T0001..
  },
];

// ── RNG identical to mock.ts ──────────────────────────────────────────────
function rand(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const RANKS = ["Maj", "Capt", "1st Lt", "Lt Col"];
const NAMES = [
  ["Tariq Al-Masri", "طارق المصري"],
  ["Omar Haddad", "عمر حداد"],
  ["Khalid Saleh", "خالد صالح"],
  ["Yousef Nimer", "يوسف نمر"],
  ["Bashar Khoury", "بشار خوري"],
  ["Mahmoud Anani", "محمود عناني"],
  ["Faris Tabbaa", "فارس طباع"],
  ["Sami Bdeir", "سامي بدير"],
  ["Hani Qutaishat", "هاني قطيشات"],
  ["Ziad Murad", "زياد مراد"],
  ["Adnan Issa", "عدنان عيسى"],
  ["Nader Awwad", "نادر عواد"],
  ["Rami Tarawneh", "رامي طراونة"],
  ["Saleem Hijazi", "سليم حجازي"],
  ["Walid Sharaiha", "وليد شريحة"],
  ["Iyad Abu-Ghazaleh", "إياد أبو غزالة"],
];
const UNITS = ["SQDN", "SQDN", "SQDN", "SQDN", "HQ Attached", "UH-60M", "UH-60AIL", "Both", "RCN", "Other"];
const AC_TYPES = ["UH-60M", "UH-60L", "UH-60AIL", "AS332"];
const SORTIE_TYPES = ["Training", "Mission", "Check Ride", "FCF", "Transport"];
const NAMES_FLT = ["NAV", "EMER", "GH", "IF", "NF", "MTF", "NVG", "MSN DAY", "MSN NVG", "EVAL"];
const SIX_MONTH_TASKS = [
  "GH", "IF", "NF", "NVG", "MTF", "NAV", "NAV FOR", "EMER", "EVAL",
  "MSN DAY", "MSN NVG", "CRS DAY", "CRS NVG", "GP.C DAY", "CPC NVG",
];

// Build all per-squadron data from a single RNG seed + pilot prefix.
function buildSquadronData(cfg) {
  const pilotId = (i) => "P" + String(cfg.pilotPrefix + i + 1).padStart(3, "0");
  const r = rand(cfg.rngSeed);

  const pilots = NAMES.map((n, i) => {
    const md = +(20 + r() * 25).toFixed(1);
    const mn = +(8 + r() * 18).toFixed(1);
    const mv = +(5 + r() * 14).toFixed(1);
    const ms = +(0 + r() * 6).toFixed(1);
    const mc = +(md * 0.7).toFixed(1);
    return {
      id: pilotId(i),
      name: n[0],
      arabicName: n[1],
      rank: RANKS[i % RANKS.length],
      phone: "079" + String(1000000 + Math.floor(r() * 9_000_000)),
      address: "Amman",
      unit: UNITS[i % UNITS.length],
      openingDay: +(800 + r() * 1500).toFixed(1),
      openingNight: +(120 + r() * 400).toFixed(1),
      openingNvg: +(60 + r() * 250).toFixed(1),
      doctorNote: i % 7 === 0 ? "Cleared with annotation" : null,
      monthDay: md, monthNight: mn, monthNvg: mv, monthSim: ms, monthCaptain: mc,
      totalDay: +(800 + r() * 1500 + md * 4).toFixed(1),
      totalNight: +(120 + r() * 400 + mn * 4).toFixed(1),
      totalNvg: +(60 + r() * 250 + mv * 4).toFixed(1),
      totalSim: +(20 + r() * 60).toFixed(1),
      totalCaptain: +(500 + r() * 1200).toFixed(1),
      expiry: {
        day:     Math.floor(r() * 200) - 30,
        night:   Math.floor(r() * 180) - 20,
        irt:     Math.floor(r() * 220) - 10,
        medical: Math.floor(r() * 320) - 40,
        sim:     Math.floor(r() * 200) - 25,
      },
      available: i % 11 !== 0,
    };
  });

  // 80 deterministic sorties — matches mock.ts SORTIES length.
  const sorties = Array.from({ length: 80 }, (_, i) => {
    const dayOffset = -Math.floor(r() * 60);
    const isNvg = r() > 0.7;
    const isNight = !isNvg && r() > 0.6;
    const dur = +(0.8 + r() * 2.4).toFixed(1);
    const a = NAMES[Math.floor(r() * NAMES.length)];
    const b = NAMES[Math.floor(r() * NAMES.length)];
    return {
      id: "S" + String(10000 + i),
      dayOffset,
      acType: AC_TYPES[Math.floor(r() * AC_TYPES.length)],
      acNumber: String(800 + Math.floor(r() * 70)),
      pilotId: pilotId(NAMES.indexOf(a)),
      coPilotId: pilotId(NAMES.indexOf(b)),
      sortieType: SORTIE_TYPES[Math.floor(r() * SORTIE_TYPES.length)],
      name: NAMES_FLT[Math.floor(r() * NAMES_FLT.length)],
      day1: !isNvg && !isNight ? dur : 0,
      day2: 0,
      dayDual: 0,
      night1: isNight ? dur : 0,
      night2: 0,
      nightDual: 0,
      nvg: isNvg ? dur : 0,
      sim: 0,
      actual: dur,
    };
  });

  const STATUSES = ["done", "done", "done", "partial", "missing"];
  const currencies = [];
  for (const p of pilots) {
    for (const task of SIX_MONTH_TASKS) {
      currencies.push({ pilotId: p.id, task, status: STATUSES[Math.floor(r() * STATUSES.length)] });
    }
  }

  // Leaves: own small LCG so the 16 rows stay deterministic per squadron.
  let ls = 13 + cfg.pilotPrefix;
  const lr = () => (ls = (ls * 9301 + 49297) % 233280) / 233280;
  const leaves = pilots.map(p => {
    const months = {};
    for (let m = 0; m < 12; m++) months[String(m)] = Math.floor(lr() * 8);
    return { pilotId: p.id, year: new Date().getUTCFullYear(), months };
  });

  const dutyWeek = ["Sun", "Mon", "Tue", "Wed", "Thu"].map((d, i) => ({
    day: d,
    mainDuty: pilots[i].name,
    standby: pilots[(i + 5) % pilots.length].name,
    rcm: pilots[(i + 9) % pilots.length].name,
  }));

  const unavailable = [
    { pilotId: pilots[2].id, fromOffset: -2, toOffset: 5,  reason: "Medical leave" },
    { pilotId: pilots[5].id, fromOffset: 1,  toOffset: 8,  reason: "Course attendance" },
  ];

  // NOTAMs — per-squadron prefix keeps notam_no unique across seeded rows.
  const notamBodies = [
    `${cfg.base} RWY closed 0800-1200Z for inspection.`,
    `TFR established sector alpha, FL080-FL120, ${cfg.name} VFR ops require coordination.`,
    `${cfg.base} tower frequency change effective 0001Z.`,
  ];
  const notams = notamBodies.map((body, i) => ({
    no: `${cfg.notamPrefix}${String(i + 1).padStart(4, "0")}`,
    offset: -(i * 2 + 1),
    body,
  }));

  const schedule = [
    { ac: "UH-60M #832",   config: "External cargo", crew: [`${pilots[0].rank} ${pilots[0].name}`, `${pilots[3].rank} ${pilots[3].name}`], mission: "NAV / EMER", takeoff: "0700", land: "1030", fuel: "2200 lbs" },
    { ac: "UH-60M #841",   config: "MEDEVAC",        crew: [`${pilots[1].rank} ${pilots[1].name}`, `${pilots[4].rank} ${pilots[4].name}`], mission: "MSN DAY",    takeoff: "0900", land: "1130", fuel: "1800 lbs" },
    { ac: "UH-60AIL #756", config: "Standard",       crew: [`${pilots[2].rank} ${pilots[2].name}`, `${pilots[5].rank} ${pilots[5].name}`], mission: "IF / MTF",   takeoff: "1300", land: "1545", fuel: "2000 lbs" },
    { ac: "UH-60M #819",   config: "NVG ready",      crew: [`${pilots[6].rank} ${pilots[6].name}`, `${pilots[7].rank} ${pilots[7].name}`], mission: "MSN NVG",    takeoff: "1900", land: "2230", fuel: "2400 lbs" },
  ];

  return { pilots, sorties, currencies, leaves, dutyWeek, unavailable, notams, schedule };
}

// ── SQL helpers ───────────────────────────────────────────────────────────
const Q = (s) => s === null || s === undefined ? "NULL" : `'${String(s).replace(/'/g, "''")}'`;
const J = (obj) => `'${JSON.stringify(obj).replace(/'/g, "''")}'::jsonb`;
const D = (offset) => `(CURRENT_DATE + ${offset})`;
const ARR = (xs) => `ARRAY[${xs.map(x => Q(x)).join(", ")}]::text[]`;

function pilotData(p) {
  const exp = p.expiry;
  const today = new Date();
  const isoOffset = (d) => {
    const t = new Date(today);
    t.setUTCDate(t.getUTCDate() + d);
    return t.toISOString().slice(0, 10);
  };
  return {
    name: p.name, arabicName: p.arabicName, rank: p.rank, phone: p.phone,
    address: p.address, unit: p.unit, available: p.available,
    openingDay: p.openingDay, openingNight: p.openingNight, openingNvg: p.openingNvg,
    doctorNote: p.doctorNote ?? undefined,
    monthDay: p.monthDay, monthNight: p.monthNight, monthNvg: p.monthNvg,
    monthSim: p.monthSim, monthCaptain: p.monthCaptain,
    totalDay: p.totalDay, totalNight: p.totalNight, totalNvg: p.totalNvg,
    totalSim: p.totalSim, totalCaptain: p.totalCaptain,
    expiry: {
      day: isoOffset(exp.day), night: isoOffset(exp.night),
      irt: isoOffset(exp.irt), medical: isoOffset(exp.medical),
      sim: isoOffset(exp.sim),
    },
  };
}

// Emit all SQL for one squadron.
function emitSquadron(lines, cfg, data) {
  const sid = cfg.id;
  lines.push(`-- ══════════════════════════════════════════════════════════════════════`);
  lines.push(`-- Squadron ${cfg.number} — ${cfg.name} (${cfg.base})`);
  lines.push(`-- UUID: ${sid}   license: ${cfg.licenseKey}`);
  lines.push(`-- ══════════════════════════════════════════════════════════════════════`);

  lines.push(`insert into squadrons (id, number, name, base) values`);
  lines.push(`  (${Q(sid)}, ${Q(cfg.number)}, ${Q(cfg.name)}, ${Q(cfg.base)})`);
  lines.push(`on conflict (id) do update set number = excluded.number, name = excluded.name, base = excluded.base;`);
  lines.push(``);

  lines.push(`insert into licenses (key, squadron_id, expires_at) values`);
  lines.push(`  (${Q(cfg.licenseKey)}, ${Q(sid)}, now() + interval '365 days')`);
  lines.push(`on conflict (key) do update set squadron_id = excluded.squadron_id, expires_at = excluded.expires_at, revoked_at = null;`);
  lines.push(``);

  // Pilots
  lines.push(`insert into pilots (id, squadron_id, rank, name, arabic_name, unit, phone, available, data) values`);
  const pilotRows = data.pilots.map(p =>
    `  (${Q(p.id)}, ${Q(sid)}, ${Q(p.rank)}, ${Q(p.name)}, ${Q(p.arabicName)}, ${Q(p.unit)}, ${Q(p.phone)}, ${p.available}, ${J(pilotData(p))})`
  );
  lines.push(pilotRows.join(",\n"));
  lines.push(`on conflict (id) do update set`);
  lines.push(`  squadron_id = excluded.squadron_id, rank = excluded.rank, name = excluded.name,`);
  lines.push(`  arabic_name = excluded.arabic_name, unit = excluded.unit, phone = excluded.phone,`);
  lines.push(`  available = excluded.available, data = excluded.data, updated_at = now();`);
  lines.push(``);

  // Sorties
  lines.push(`delete from sorties where squadron_id = ${Q(sid)};`);
  lines.push(`insert into sorties (squadron_id, pilot_id, co_pilot_id, date, ac_type, ac_number, sortie_type, sortie_name, data) values`);
  const sortieRows = data.sorties.map(s =>
    `  (${Q(sid)}, ${Q(s.pilotId)}, ${Q(s.coPilotId)}, ${D(s.dayOffset)}, ${Q(s.acType)}, ${Q(s.acNumber)}, ${Q(s.sortieType)}, ${Q(s.name)}, ${J({
      day1: s.day1, day2: s.day2, dayDual: s.dayDual,
      night1: s.night1, night2: s.night2, nightDual: s.nightDual,
      nvg: s.nvg, sim: s.sim, actual: s.actual,
    })})`
  );
  lines.push(sortieRows.join(",\n") + ";");
  lines.push(``);

  // Currencies
  lines.push(`with cycle as (`);
  lines.push(`  select case when extract(month from current_date) <= 6`);
  lines.push(`              then make_date(extract(year from current_date)::int, 1, 1)`);
  lines.push(`              else make_date(extract(year from current_date)::int, 7, 1) end as start`);
  lines.push(`)`);
  lines.push(`insert into currencies (squadron_id, pilot_id, task, status, cycle_start)`);
  lines.push(`select ${Q(sid)}, v.pilot_id, v.task, v.status, c.start`);
  lines.push(`from cycle c, (values`);
  const currencyRows = data.currencies.map(c => `  (${Q(c.pilotId)}, ${Q(c.task)}, ${Q(c.status)})`);
  lines.push(currencyRows.join(",\n"));
  lines.push(`) as v(pilot_id, task, status)`);
  lines.push(`on conflict (squadron_id, pilot_id, task, cycle_start) do update set status = excluded.status, updated_at = now();`);
  lines.push(``);

  // Leaves
  lines.push(`insert into leaves (squadron_id, pilot_id, year, months) values`);
  const leaveRows = data.leaves.map(l => `  (${Q(sid)}, ${Q(l.pilotId)}, ${l.year}, ${J(l.months)})`);
  lines.push(leaveRows.join(",\n"));
  lines.push(`on conflict (squadron_id, pilot_id, year) do update set months = excluded.months;`);
  lines.push(``);

  // Duty week
  lines.push(`delete from duty_week where squadron_id = ${Q(sid)};`);
  lines.push(`insert into duty_week (squadron_id, day, main_duty, standby, rcm, effective_from) values`);
  const dutyRows = data.dutyWeek.map(d => `  (${Q(sid)}, ${Q(d.day)}, ${Q(d.mainDuty)}, ${Q(d.standby)}, ${Q(d.rcm)}, current_date)`);
  lines.push(dutyRows.join(",\n") + ";");
  lines.push(``);

  // Unavailable
  lines.push(`delete from unavailable where squadron_id = ${Q(sid)};`);
  lines.push(`insert into unavailable (squadron_id, pilot_id, from_date, to_date, reason) values`);
  const unavailRows = data.unavailable.map(u => `  (${Q(sid)}, ${Q(u.pilotId)}, ${D(u.fromOffset)}, ${D(u.toOffset)}, ${Q(u.reason)})`);
  lines.push(unavailRows.join(",\n") + ";");
  lines.push(``);

  // NOTAMs
  lines.push(`delete from notams where squadron_id = ${Q(sid)};`);
  lines.push(`insert into notams (squadron_id, notam_no, posted_on, body) values`);
  const notamRows = data.notams.map(n => `  (${Q(sid)}, ${Q(n.no)}, ${D(n.offset)}, ${Q(n.body)})`);
  lines.push(notamRows.join(",\n") + ";");
  lines.push(``);

  // Schedule
  lines.push(`delete from schedule where squadron_id = ${Q(sid)} and flight_date = current_date;`);
  lines.push(`insert into schedule (squadron_id, flight_date, ac, config, crew, mission, takeoff, land, fuel) values`);
  const schedRows = data.schedule.map(s => `  (${Q(sid)}, current_date, ${Q(s.ac)}, ${Q(s.config)}, ${ARR(s.crew)}, ${Q(s.mission)}, ${Q(s.takeoff)}, ${Q(s.land)}, ${Q(s.fuel)})`);
  lines.push(schedRows.join(",\n") + ";");
  lines.push(``);

  // Admin user — one per squadron so operators can log straight into any of them.
  lines.push(`-- Admin for ${cfg.name}: ${cfg.adminEmail} / ${cfg.adminPassword}`);
  lines.push(`delete from auth.identities where user_id = ${Q(cfg.adminUserId)};`);
  lines.push(`delete from auth.users      where id      = ${Q(cfg.adminUserId)};`);
  lines.push(`insert into auth.users (`);
  lines.push(`  instance_id, id, aud, role, email, encrypted_password,`);
  lines.push(`  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,`);
  lines.push(`  created_at, updated_at, confirmation_token, email_change,`);
  lines.push(`  email_change_token_new, recovery_token`);
  lines.push(`) values (`);
  lines.push(`  '00000000-0000-0000-0000-000000000000', ${Q(cfg.adminUserId)},`);
  lines.push(`  'authenticated', 'authenticated', ${Q(cfg.adminEmail)},`);
  lines.push(`  crypt(${Q(cfg.adminPassword)}, gen_salt('bf')),`);
  lines.push(`  now(),`);
  lines.push(`  jsonb_build_object('squadron_id', ${Q(sid)}, 'role', 'admin', 'provider', 'email', 'providers', jsonb_build_array('email')),`);
  lines.push(`  '{}'::jsonb, now(), now(), '', '', '', ''`);
  lines.push(`);`);
  lines.push(`insert into auth.identities (`);
  lines.push(`  provider_id, user_id, identity_data, provider,`);
  lines.push(`  last_sign_in_at, created_at, updated_at`);
  lines.push(`) values (`);
  lines.push(`  ${Q(cfg.adminUserId)}, ${Q(cfg.adminUserId)},`);
  lines.push(`  jsonb_build_object('sub', ${Q(cfg.adminUserId)}, 'email', ${Q(cfg.adminEmail)}, 'email_verified', true),`);
  lines.push(`  'email', now(), now(), now()`);
  lines.push(`);`);
  lines.push(``);
  lines.push(`insert into users (id, squadron_id, username, display_name, role) values`);
  lines.push(`  (${Q(cfg.adminUserId)}, ${Q(sid)}, ${Q(cfg.adminUsername)}, ${Q(cfg.adminDisplay)}, 'admin')`);
  lines.push(`on conflict (id) do update set`);
  lines.push(`  squadron_id = excluded.squadron_id, username = excluded.username,`);
  lines.push(`  display_name = excluded.display_name, role = excluded.role;`);
  lines.push(``);
}

// ── Compose SQL ───────────────────────────────────────────────────────────
const lines = [];
lines.push(`-- Auto-generated by generate-seed.mjs. Do not edit by hand.`);
lines.push(`-- Re-run: node artifacts/pilot-dashboard/supabase/seed/generate-seed.mjs`);
lines.push(`-- Generated at: ${new Date().toISOString()}`);
lines.push(``);
lines.push(`-- This seed populates ${SQUADRONS.length} demo squadrons with realistic data so a`);
lines.push(`-- freshly provisioned project loads with the same baseline the in-memory`);
lines.push(`-- preview shows AND Hawk Eye HQ commanders can immediately compare`);
lines.push(`-- squadrons side-by-side on the cross-squadron pilot table and dashboards.`);
lines.push(`--`);
lines.push(`-- It must run with the SERVICE ROLE (or as the postgres superuser) because`);
lines.push(`-- Row Level Security on every operational table is gated by a JWT claim that`);
lines.push(`-- a fresh seed connection does not yet have. The service role bypasses RLS.`);
lines.push(``);
lines.push(`begin;`);
lines.push(``);

const totals = { pilots: 0, sorties: 0, currencies: 0, leaves: 0, notams: 0 };
for (const cfg of SQUADRONS) {
  const data = buildSquadronData(cfg);
  emitSquadron(lines, cfg, data);
  totals.pilots     += data.pilots.length;
  totals.sorties    += data.sorties.length;
  totals.currencies += data.currencies.length;
  totals.leaves     += data.leaves.length;
  totals.notams     += data.notams.length;
}

lines.push(`commit;`);
lines.push(``);

writeFileSync(OUT, lines.join("\n"));
console.log(`Wrote ${OUT} (${lines.length} lines)`);
console.log(`  squadrons: ${SQUADRONS.length}  pilots: ${totals.pilots}  sorties: ${totals.sorties}`);
console.log(`  currencies: ${totals.currencies}  leaves: ${totals.leaves}  notams: ${totals.notams}`);
for (const c of SQUADRONS) {
  console.log(`  - ${c.name} (#${c.number}) @ ${c.base}  key=${c.licenseKey}`);
}
