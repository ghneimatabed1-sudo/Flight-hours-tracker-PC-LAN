// Build a professional, colorful, non-technical presentation PDF that
// explains the Hawk Eye ecosystem for senior leadership.  Uses pdfkit so
// it runs entirely in-Node with no headless browser needed.
//
// Layout: landscape A4 (842 x 595 pt), 16:9-ish, so hero images fill the
// page cinematically.  Brand palette: RJAF navy + gold.
//
// Run: node exports/hawkeye-pdf/build.mjs
// Out: exports/hawkeye-pdf/HawkEye-Ecosystem.pdf

import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";

const OUT = "exports/hawkeye-pdf/HawkEye-Ecosystem.pdf";
const IMG = "exports/hawkeye-pdf/images";
const SCR = "exports/hawkeye-pdf/screens";
const EMBLEM = "artifacts/pilot-dashboard/public/brand/emblem.png";

// Prefer the compressed .jpg hero images; fall back to .png if the .jpg
// twin is missing for an individual hero.
const hero = (name) => {
  const jpg = `${IMG}/${name}.jpg`;
  const png = `${IMG}/${name}.png`;
  return fs.existsSync(jpg) ? jpg : png;
};

// Brand palette
const NAVY_DEEP   = "#05081a";
const NAVY        = "#0b1130";
const NAVY_SOFT   = "#141a3a";
const GOLD        = "#d4af37";
const GOLD_BRIGHT = "#f0c955";
const GOLD_DIM    = "#8a7221";
const INK_HI      = "#f5f2e7";
const INK         = "#cfd3e0";
const INK_DIM     = "#8b90a8";

const PAGE_W = 842;  // landscape A4
const PAGE_H = 595;

const VERSION = "1.0.49";

// --------------------------------------------------------------------------
// Drawing helpers
// --------------------------------------------------------------------------

function bg(doc, color = NAVY_DEEP) {
  doc.rect(0, 0, PAGE_W, PAGE_H).fill(color);
}

function vignette(doc) {
  for (let i = 0; i < 6; i++) {
    const alpha = 0.06 - i * 0.009;
    doc.fillOpacity(alpha).fill(GOLD);
    doc.circle(PAGE_W / 2, PAGE_H / 2, 300 + i * 40);
    doc.fill();
  }
  doc.fillOpacity(1);
}

function topBar(doc, title, page) {
  doc.save();
  doc.image(EMBLEM, 40, 28, { width: 24 });
  doc.fillColor(INK_HI).fontSize(11).font("Helvetica-Bold")
     .text("HAWK EYE", 72, 32, { lineBreak: false });
  doc.fillColor(INK_DIM).fontSize(8).font("Helvetica")
     .text("RJAF SQUADRON OPS", 72, 47, { lineBreak: false });
  if (title) {
    doc.fillColor(GOLD).fontSize(9).font("Helvetica-Bold")
       .text(title.toUpperCase(), 200, 37, { characterSpacing: 2, lineBreak: false });
  }
  doc.fillColor(INK_DIM).fontSize(8).font("Helvetica")
     .text(`PAGE ${page}`, PAGE_W - 90, 40, { width: 50, align: "right" });
  doc.moveTo(40, 66).lineTo(PAGE_W - 40, 66).lineWidth(0.6).strokeColor(GOLD_DIM).stroke();
  doc.restore();
}

function bottomBar(doc) {
  doc.save();
  doc.moveTo(40, PAGE_H - 36).lineTo(PAGE_W - 40, PAGE_H - 36).lineWidth(0.4).strokeColor(GOLD_DIM).stroke();
  doc.fillColor(INK_DIM).fontSize(8).font("Helvetica")
     .text("ROYAL JORDANIAN AIR FORCE  ·  SQUADRON OPERATIONS", 40, PAGE_H - 26, { lineBreak: false });
  doc.fillColor(INK_DIM).fontSize(8)
     .text("CONFIDENTIAL — FOR COMMAND REVIEW", PAGE_W - 260, PAGE_H - 26, { width: 220, align: "right" });
  doc.restore();
}

// Title block with an adaptive gold underline that sits below the wrapped
// title — never through it.  Returns the rule-y so callers can anchor the
// first body line cleanly.
function sectionTitle(doc, x, y, eyebrow, title, width = PAGE_W - x - 48) {
  doc.fillColor(GOLD).fontSize(9).font("Helvetica-Bold")
     .text(eyebrow.toUpperCase(), x, y, { characterSpacing: 3, width, lineBreak: false });
  doc.fillColor(INK_HI).fontSize(26).font("Helvetica-Bold");
  const titleH = doc.heightOfString(title, { width });
  doc.text(title, x, y + 16, { width });
  const rule = y + 16 + titleH + 10;
  doc.moveTo(x, rule).lineTo(x + 54, rule).lineWidth(2).strokeColor(GOLD).stroke();
  return rule;
}

function body(doc, x, y, w, text, opts = {}) {
  doc.fillColor(opts.color || INK).fontSize(opts.size || 11).font(opts.font || "Helvetica");
  doc.text(text, x, y, { width: w, align: opts.align || "left", lineGap: opts.lineGap ?? 3 });
  return doc.y;
}

function bulletList(doc, x, y, w, items, opts = {}) {
  const size = opts.size || 11;
  doc.fontSize(size).font("Helvetica");
  let cy = y;
  for (const it of items) {
    doc.save();
    doc.translate(x, cy + size * 0.45);
    doc.rotate(45);
    doc.rect(-3, -3, 6, 6).fill(GOLD);
    doc.restore();
    const [head, ...rest] = Array.isArray(it) ? it : [it];
    doc.fillColor(INK_HI).font("Helvetica-Bold").fontSize(size)
       .text(head, x + 14, cy, { width: w - 14, lineGap: 2, continued: rest.length > 0 });
    if (rest.length > 0) {
      doc.fillColor(INK).font("Helvetica").text(" " + rest.join(" "), { lineGap: 2 });
    }
    cy = doc.y + (opts.gap ?? 6);
  }
  return cy;
}

function card(doc, x, y, w, h, title, text, iconFn) {
  doc.save();
  doc.roundedRect(x, y, w, h, 8).fill(NAVY_SOFT);
  doc.roundedRect(x, y, w, h, 8).lineWidth(0.7).strokeColor(GOLD_DIM).stroke();
  if (iconFn) iconFn(doc, x + 16, y + 16);
  doc.fillColor(GOLD_BRIGHT).fontSize(13).font("Helvetica-Bold")
     .text(title, x + 16, y + 56, { width: w - 32 });
  doc.fillColor(INK).fontSize(10).font("Helvetica")
     .text(text, x + 16, doc.y + 4, { width: w - 32, lineGap: 2 });
  doc.restore();
}

function heroBox(doc, name, x, y, w, h) {
  if (fs.existsSync(hero(name))) {
    doc.save();
    doc.roundedRect(x, y, w, h, 10).clip();
    doc.image(hero(name), x, y, { width: w, height: h });
    doc.restore();
    doc.roundedRect(x, y, w, h, 10).lineWidth(0.8).strokeColor(GOLD_DIM).stroke();
  }
}

function calloutBar(doc, x, y, w, label, text) {
  const h = 56;
  doc.roundedRect(x, y, w, h, 8).fill(NAVY_SOFT);
  doc.roundedRect(x, y, w, h, 8).lineWidth(0.7).strokeColor(GOLD_DIM).stroke();
  doc.fillColor(GOLD).fontSize(10).font("Helvetica-Bold")
     .text(label, x + 16, y + 14, { characterSpacing: 3, lineBreak: false });
  doc.fillColor(INK_HI).fontSize(10.5).font("Helvetica")
     .text(text, x + 16, y + 30, { width: w - 32, lineGap: 2 });
}

// --------------------------------------------------------------------------
// Icon glyphs (drawn, not fonts)
// --------------------------------------------------------------------------
function iconPC(doc, x, y) {
  doc.roundedRect(x, y, 28, 20, 2).lineWidth(1).strokeColor(GOLD).stroke();
  doc.rect(x + 10, y + 22, 8, 4).fill(GOLD);
  doc.rect(x + 4, y + 27, 20, 1.5).fill(GOLD);
}
function iconPhone(doc, x, y) {
  doc.roundedRect(x + 6, y, 18, 30, 3).lineWidth(1).strokeColor(GOLD).stroke();
  doc.circle(x + 15, y + 27, 1.2).fill(GOLD);
  doc.rect(x + 11, y + 3, 8, 1).fill(GOLD);
}
function iconCloud(doc, x, y) {
  doc.save().translate(x, y);
  doc.circle(8, 18, 7).circle(18, 14, 9).circle(26, 20, 7).fillAndStroke(NAVY_SOFT, GOLD);
  doc.rect(4, 18, 26, 10).fillAndStroke(NAVY_SOFT, GOLD);
  doc.restore();
}
function iconShield(doc, x, y) {
  doc.save().translate(x, y);
  doc.moveTo(14, 0).lineTo(28, 6).lineTo(28, 18).lineTo(14, 30).lineTo(0, 18).lineTo(0, 6).closePath()
     .lineWidth(1).strokeColor(GOLD).stroke();
  doc.moveTo(8, 14).lineTo(13, 20).lineTo(22, 10).lineWidth(1.5).strokeColor(GOLD).stroke();
  doc.restore();
}
function iconBell(doc, x, y) {
  doc.save().translate(x, y);
  doc.moveTo(4, 22).lineTo(26, 22).lineWidth(1).strokeColor(GOLD).stroke();
  doc.moveTo(6, 22).quadraticCurveTo(6, 6, 15, 6).quadraticCurveTo(24, 6, 24, 22).strokeColor(GOLD).stroke();
  doc.circle(15, 27, 2).fill(GOLD);
  doc.restore();
}
function iconChain(doc, x, y) {
  doc.save().translate(x, y);
  doc.roundedRect(0, 8, 14, 12, 4).lineWidth(1.2).strokeColor(GOLD).stroke();
  doc.roundedRect(14, 8, 14, 12, 4).lineWidth(1.2).strokeColor(GOLD).stroke();
  doc.restore();
}
function iconLog(doc, x, y) {
  doc.save().translate(x, y);
  doc.roundedRect(0, 2, 26, 26, 2).lineWidth(1).strokeColor(GOLD).stroke();
  [8, 14, 20].forEach(yy => doc.moveTo(4, yy).lineTo(22, yy).strokeColor(GOLD).stroke());
  doc.restore();
}
function iconCalendar(doc, x, y) {
  doc.save().translate(x, y);
  doc.roundedRect(0, 4, 28, 24, 2).lineWidth(1).strokeColor(GOLD).stroke();
  doc.rect(0, 4, 28, 6).fillColor(GOLD).fill();
  doc.rect(6, 1, 2, 6).fillColor(GOLD).fill().rect(20, 1, 2, 6).fillColor(GOLD).fill();
  doc.restore();
}
function iconMessage(doc, x, y) {
  doc.save().translate(x, y);
  doc.roundedRect(0, 4, 28, 18, 4).lineWidth(1).strokeColor(GOLD).stroke();
  doc.moveTo(8, 22).lineTo(10, 26).lineTo(14, 22).lineWidth(1).strokeColor(GOLD).stroke();
  doc.restore();
}
function iconBadge(doc, x, y) {
  doc.save().translate(x, y);
  doc.moveTo(14, 0).lineTo(26, 8).lineTo(22, 26).lineTo(6, 26).lineTo(2, 8).closePath()
     .lineWidth(1).strokeColor(GOLD).stroke();
  doc.circle(14, 14, 4).fillColor(GOLD).fill();
  doc.restore();
}
function iconReport(doc, x, y) {
  doc.save().translate(x, y);
  doc.moveTo(0, 0).lineTo(18, 0).lineTo(26, 8).lineTo(26, 28).lineTo(0, 28).closePath()
     .lineWidth(1).strokeColor(GOLD).stroke();
  [13, 18, 23].forEach(yy => doc.moveTo(4, yy).lineTo(22, yy).strokeColor(GOLD).stroke());
  doc.restore();
}
function iconGuest(doc, x, y) {
  doc.save().translate(x, y);
  doc.circle(9, 8, 5).lineWidth(1).strokeColor(GOLD).stroke();
  doc.moveTo(2, 26).quadraticCurveTo(9, 14, 16, 26).strokeColor(GOLD).stroke();
  doc.circle(22, 12, 4).strokeColor(GOLD).stroke();
  doc.moveTo(16, 26).quadraticCurveTo(22, 18, 28, 26).strokeColor(GOLD).stroke();
  doc.restore();
}
function iconLeave(doc, x, y) {
  doc.save().translate(x, y);
  doc.roundedRect(0, 2, 28, 26, 2).lineWidth(1).strokeColor(GOLD).stroke();
  doc.moveTo(7, 15).lineTo(12, 20).lineTo(22, 10).lineWidth(1.5).strokeColor(GOLD).stroke();
  doc.restore();
}
function iconGlobe(doc, x, y) {
  doc.save().translate(x, y);
  doc.circle(14, 14, 12).lineWidth(1).strokeColor(GOLD).stroke();
  doc.moveTo(2, 14).lineTo(26, 14).strokeColor(GOLD).stroke();
  doc.ellipse(14, 14, 6, 12).lineWidth(1).strokeColor(GOLD).stroke();
  doc.restore();
}
function iconOffline(doc, x, y) {
  doc.save().translate(x, y);
  doc.moveTo(14, 4).quadraticCurveTo(2, 4, 2, 18).lineTo(26, 18).quadraticCurveTo(26, 4, 14, 4)
     .lineWidth(1).strokeColor(GOLD).stroke();
  doc.moveTo(4, 4).lineTo(24, 26).lineWidth(1.4).strokeColor(GOLD).stroke();
  doc.restore();
}

// --------------------------------------------------------------------------
// Pages
// --------------------------------------------------------------------------

function pageCover(doc) {
  bg(doc, NAVY_DEEP);
  if (fs.existsSync(hero("cover_hero"))) {
    doc.image(hero("cover_hero"), 0, 0, { width: PAGE_W, height: PAGE_H });
  }
  for (let i = 0; i < 20; i++) {
    doc.fillOpacity(0.05).fill(NAVY_DEEP);
    doc.rect(0, i * (PAGE_H / 20), PAGE_W, PAGE_H / 20 + 1);
  }
  doc.fillOpacity(0.55).rect(0, 0, PAGE_W, PAGE_H).fill(NAVY_DEEP);
  doc.fillOpacity(1);

  doc.image(EMBLEM, 48, 48, { width: 54 });

  doc.roundedRect(PAGE_W - 200, 52, 152, 22, 11).lineWidth(0.6).strokeColor(GOLD).stroke();
  doc.fillColor(GOLD).fontSize(8).font("Helvetica-Bold")
     .text("COMMAND BRIEFING · 2026", PAGE_W - 190, 58, { characterSpacing: 2.5, lineBreak: false });

  doc.fillColor(GOLD).fontSize(11).font("Helvetica-Bold")
     .text("ROYAL JORDANIAN AIR FORCE", 48, 320, { characterSpacing: 5, lineBreak: false });
  doc.fillColor(INK_HI).fontSize(64).font("Helvetica-Bold")
     .text("HAWK EYE", 48, 340, { lineBreak: false });
  doc.fillColor(INK).fontSize(20).font("Helvetica")
     .text("The Digital Squadron Operations Ecosystem", 48, 420, { lineBreak: false });
  doc.fillColor(INK_DIM).fontSize(12).font("Helvetica-Oblique")
     .text("One logbook. Every pilot. Every squadron. Every decision — in sync.",
           48, 452, { lineBreak: false });

  doc.moveTo(48, PAGE_H - 48).lineTo(160, PAGE_H - 48).lineWidth(1.5).strokeColor(GOLD).stroke();
  doc.fillColor(INK_DIM).fontSize(9).font("Helvetica")
     .text("Prepared for Command Review", 48, PAGE_H - 40, { lineBreak: false });
  doc.fillColor(INK_DIM).fontSize(9)
     .text(`Version ${VERSION}  ·  April 2026`, PAGE_W - 240, PAGE_H - 40,
           { width: 200, align: "right" });
}

function pageContents(doc) {
  bg(doc, NAVY);
  topBar(doc, "Contents", 2);
  sectionTitle(doc, 48, 100, "What this briefing covers",
               "A tour of Hawk Eye.", 500);

  const entries = [
    [ 3, "What is Hawk Eye"],
    [ 4, "The ecosystem — PC, phone, cloud"],
    [ 5, "How data travels — and how it is sealed"],
    [ 6, "Security & privacy — the sealed envelope"],
    [ 7, "Defence in depth — what stops an intruder"],
    [ 8, "The PC dashboard at a glance"],
    [ 9, "Pilot roster & records"],
    [10, "Sorties & flight logging"],
    [11, "Currencies & certifications"],
    [12, "Schedule sharing — Flight → Squadron → Wing → Base"],
    [13, "Private messages & command inbox"],
    [14, "Alerts & notifications — per-PC chime"],
    [15, "Leave, availability & crew rest"],
    [16, "Reports & exports — one-click RCN forms"],
    [17, "Multi-tier command & guest pilots"],
    [18, "The pilot's mobile app"],
    [19, "Bilingual, offline, backup & settings"],
    [20, "Before & after — what Hawk Eye replaces"],
    [21, "Closing"],
  ];

  const colW = 360, rowH = 22;
  const left = entries.slice(0, 10);
  const right = entries.slice(10);

  function drawColumn(col, x, y) {
    col.forEach((e, i) => {
      const cy = y + i * rowH;
      doc.fillColor(GOLD).fontSize(10).font("Helvetica-Bold")
         .text(String(e[0]).padStart(2, "0"), x, cy, { width: 26, lineBreak: false });
      doc.fillColor(INK_HI).fontSize(11).font("Helvetica")
         .text(e[1], x + 34, cy, { width: colW - 34, lineBreak: false });
      doc.save();
      for (let dx = x + 34 + doc.widthOfString(e[1]) + 6; dx < x + colW - 8; dx += 4) {
        doc.circle(dx, cy + 6, 0.6).fillColor(GOLD_DIM).fill();
      }
      doc.restore();
    });
  }
  drawColumn(left,  48,  200);
  drawColumn(right, 430, 200);

  bottomBar(doc);
}

function pageWhatIs(doc) {
  bg(doc, NAVY);
  topBar(doc, "Overview", 3);
  const ruleY = sectionTitle(doc, 48, 100, "What is Hawk Eye?",
               "A single nerve centre for the squadron.", 380);

  body(doc, 48, ruleY + 24, 360,
    "Hawk Eye replaces paper logbooks, spreadsheets, WhatsApp group chats " +
    "and scattered clipboards with one living system that every pilot and " +
    "every commander can trust.\n\n" +
    "From the moment a pilot lands to the moment the wing commander signs " +
    "off the monthly report, the same data flows across the entire chain " +
    "— no copy-paste, no lost pages, no guesswork about who has the latest " +
    "numbers.",
    { lineGap: 4, size: 11.5 }
  );

  heroBox(doc, "logbook_modern", 440, 100, 354, 380);

  const stats = [
    ["One",      "logbook across the whole squadron"],
    ["Zero",     "paper forms to lose or forge"],
    ["Real-time","sync between PC and mobile"],
    ["24 / 7",   "availability from anywhere secure"],
  ];
  const sx = 48, sy = 500, sw = 185;
  stats.forEach((s, i) => {
    doc.fillColor(GOLD_BRIGHT).fontSize(22).font("Helvetica-Bold")
       .text(s[0], sx + i * sw, sy, { lineBreak: false });
    doc.fillColor(INK_DIM).fontSize(9).font("Helvetica")
       .text(s[1], sx + i * sw, sy + 28, { width: sw - 10 });
  });
  bottomBar(doc);
}

function pageEcosystem(doc) {
  bg(doc, NAVY);
  topBar(doc, "Ecosystem", 4);
  sectionTitle(doc, 48, 100, "Three doors, one room",
               "How the pieces fit together.", 430);

  heroBox(doc, "ecosystem_diagram", 440, 172, 354, 278);

  const boxes = [
    { t: "Commander's PC",
      d: "Windows desktop installer used at every squadron, wing and base command post. Full command view, schedule authoring, message inbox, reports.",
      i: iconPC },
    { t: "Pilot's Phone",
      d: "Android & iOS app for every pilot. Log sorties from the flight line, read alerts from command, track currency, get reminders before certifications expire.",
      i: iconPhone },
    { t: "Secure Cloud",
      d: "A dedicated private database holds the shared state. Every PC and every phone talks only to this cloud — never directly to each other.",
      i: iconCloud },
  ];
  let cy = 180;
  for (const b of boxes) {
    card(doc, 48, cy, 380, 88, b.t, b.d, b.i);
    cy += 96;
  }

  calloutBar(doc, 48, 484, 746, "THE KEY IDEA",
    "A number entered on any pilot's phone appears on every authorised commander's screen within seconds — and vice versa.");
  bottomBar(doc);
}

function pageDataFlow(doc) {
  bg(doc, NAVY);
  topBar(doc, "Data Flow", 5);
  sectionTitle(doc, 48, 100, "How data travels",
               "And how every trip is sealed.", 430);

  heroBox(doc, "data_flow_encryption", 48, 172, 746, 230);

  // Three-step explanation below the hero
  const steps = [
    { n: "1", t: "Sealed at the source",
      d: "The moment a pilot taps Save — or a commander sends a message — the data is wrapped in a bank-grade encrypted envelope on the device itself." },
    { n: "2", t: "Carried through the cloud",
      d: "The sealed envelope travels to a private cloud vault that only Hawk Eye devices can address. Nothing in the middle can read the contents." },
    { n: "3", t: "Opened only where entitled",
      d: "The other end — the authorised PC or phone — is the only place the envelope is opened, and only the fields that role is allowed to see." },
  ];
  const colW = (PAGE_W - 96 - 2 * 12) / 3;
  steps.forEach((s, i) => {
    const x = 48 + i * (colW + 12);
    doc.roundedRect(x, 418, colW, 120, 8).fill(NAVY_SOFT);
    doc.roundedRect(x, 418, colW, 120, 8).lineWidth(0.7).strokeColor(GOLD_DIM).stroke();
    doc.fillColor(GOLD).fontSize(20).font("Helvetica-Bold")
       .text(s.n, x + 14, 428, { lineBreak: false });
    doc.fillColor(GOLD_BRIGHT).fontSize(12).font("Helvetica-Bold")
       .text(s.t, x + 42, 432, { width: colW - 56, lineBreak: false });
    doc.fillColor(INK).fontSize(10).font("Helvetica")
       .text(s.d, x + 14, 460, { width: colW - 28, lineGap: 2 });
  });

  bottomBar(doc);
}

function pageSecurity(doc) {
  bg(doc, NAVY);
  topBar(doc, "Security & Privacy", 6);
  sectionTitle(doc, 48, 100, "Built for trust",
               "Security & privacy, in plain language.", 430);

  heroBox(doc, "security_envelope", 500, 100, 294, 380);

  doc.roundedRect(48, 180, 420, 110, 8).fill(NAVY_SOFT);
  doc.roundedRect(48, 180, 420, 110, 8).lineWidth(0.7).strokeColor(GOLD_DIM).stroke();
  doc.fillColor(GOLD).fontSize(10).font("Helvetica-Bold")
     .text("THE SEALED-ENVELOPE PRINCIPLE", 64, 194, { characterSpacing: 2.5, lineBreak: false });
  doc.fillColor(INK_HI).fontSize(10.5).font("Helvetica")
     .text("Every piece of information that leaves a PC or a phone travels " +
           "inside a sealed digital envelope.  Only the authorised server can " +
           "open it.  A third party tapping the line would see sealed " +
           "envelopes — never the letters inside.",
           64, 214, { width: 390, lineGap: 2 });

  bulletList(doc, 48, 310, 420, [
    ["Two-factor sign-in —", "each super-admin pairs an authenticator app; a stolen password alone is not enough to get in."],
    ["Role-based access —",  "a flight commander sees flight data, a wing commander sees wing data, a pilot sees their own record. Nothing beyond their mandate."],
    ["Private by design —",  "the database is locked down at the server level — even someone with a direct database connection only sees rows their role is entitled to."],
  ], { size: 10 });

  bottomBar(doc);
}

function pageDefence(doc) {
  bg(doc, NAVY);
  topBar(doc, "Defence in Depth", 7);
  sectionTitle(doc, 48, 100, "What stops an intruder",
               "More than one lock on the door.", 430);

  heroBox(doc, "intruder_blocked", 440, 172, 354, 240);

  bulletList(doc, 48, 180, 380, [
    ["Wrong password repeatedly?", "the account is frozen for a cool-down window. Brute force is blocked at the door."],
    ["Stolen laptop?", "the app is locked behind the commander's password; the disk is encrypted; the database is never stored locally in the clear."],
    ["Someone taps the line?", "they see sealed envelopes, never the letters inside — transport encryption is the same standard banks use."],
    ["Someone steals the database?", "passwords are stored as one-way fingerprints only; there is nothing there to read back."],
    ["A device goes missing?", "it can be revoked from the trusted-device list; the next sign-in from that PC is refused."],
  ], { size: 10, gap: 5 });

  calloutBar(doc, 48, 470, 746, "EVERY ACTION IS SIGNED",
    "Who did what, when, and from which PC is recorded automatically — and cannot be altered by the person who made the change.");
  bottomBar(doc);
}

function pageDashboard(doc) {
  bg(doc, NAVY);
  topBar(doc, "PC Dashboard", 8);
  sectionTitle(doc, 48, 100, "For commanders",
               "The Hawk Eye dashboard.", 360);

  const feats = [
    ["Live KPIs —",                 "monthly hours, sorties flown, pilots available — all on the home screen."],
    ["Sortie log & live entry —",   "add, approve and audit every flight."],
    ["Flight schedule authoring —", "draft, review and release the next day's plan."],
    ["Currency & expiry tracking —","NVG, instrument, tactical, medical — no surprises."],
    ["Roster & ranking view —",     "a league table that keeps the squadron sharp."],
    ["Leaves & unavailability —",   "see who can fly before you assign anyone."],
    ["Monthly reports —",            "RCN Forms 1 – 4 auto-generated, bilingual (EN / AR)."],
    ["One-click PDF exports —",      "every view, ready for the wing commander."],
  ];
  bulletList(doc, 48, 180, 360, feats, { size: 10.5 });

  const shot = fs.existsSync(`${SCR}/splash2.jpg`) ? `${SCR}/splash2.jpg` : `${SCR}/dashboard-home.jpg`;
  if (fs.existsSync(shot)) {
    doc.roundedRect(430, 180, 364, 280, 8).fill("#000");
    doc.save();
    doc.roundedRect(434, 184, 356, 272, 6).clip();
    doc.image(shot, 434, 184, { width: 356, height: 272 });
    doc.restore();
    doc.roundedRect(430, 180, 364, 280, 8).lineWidth(0.8).strokeColor(GOLD_DIM).stroke();
    doc.fillColor(INK_DIM).fontSize(8).font("Helvetica-Oblique")
       .text("Hawk Eye dashboard · sign-in screen", 430, 466, { width: 364, align: "center" });
  }

  doc.roundedRect(430, 490, 364, 40, 6).fill(NAVY_SOFT)
     .roundedRect(430, 490, 364, 40, 6).lineWidth(0.6).strokeColor(GOLD_DIM).stroke();
  doc.fillColor(GOLD).fontSize(9).font("Helvetica-Bold")
     .text("BILINGUAL", 446, 502, { characterSpacing: 2, lineBreak: false });
  doc.fillColor(INK_HI).fontSize(10.5).font("Helvetica")
     .text("Full English & Arabic interface, right-to-left aware.", 510, 503, { width: 270 });
  bottomBar(doc);
}

function pageRoster(doc) {
  bg(doc, NAVY);
  topBar(doc, "Pilot Roster & Records", 9);
  sectionTitle(doc, 48, 100, "Every pilot, one record",
               "The living roster — never out of date.", 500);

  bulletList(doc, 48, 180, 360, [
    ["Central squadron roster —", "rank, English/Arabic names, military number, unit assignment (SQDN or HQ Attached)."],
    ["Pilot dossier —", "career totals, qualifications, full sortie history and contact details, on one screen."],
    ["Rankings & leaderboards —", "sort by hours, sorties, NVG time, mission type — keeps the squadron sharp."],
    ["Unit management —", "move pilots between units; changes reflect across every view instantly."],
    ["Historical CSV import —", "bring legacy pilots and sorties in with a guided column-mapping tool."],
    ["Archive inactive pilots —", "keep the active roster clean while preserving every historical row."],
  ], { size: 10.5, gap: 5 });

  // Mini stats panel
  const stats = [
    { n: "All ranks", d: "from Cadet to Wing Commander, in one list" },
    { n: "Arabic & English", d: "names shown side by side on every report" },
    { n: "No duplicates", d: "military-number matching catches repeats automatically" },
  ];
  stats.forEach((s, i) => {
    const y = 180 + i * 104;
    doc.roundedRect(440, y, 354, 92, 8).fill(NAVY_SOFT);
    doc.roundedRect(440, y, 354, 92, 8).lineWidth(0.7).strokeColor(GOLD_DIM).stroke();
    iconBadge(doc, 456, y + 14);
    doc.fillColor(GOLD_BRIGHT).fontSize(14).font("Helvetica-Bold")
       .text(s.n, 494, y + 16, { width: 284 });
    doc.fillColor(INK).fontSize(10.5).font("Helvetica")
       .text(s.d, 494, doc.y + 4, { width: 284, lineGap: 2 });
  });
  bottomBar(doc);
}

function pageSorties(doc) {
  bg(doc, NAVY);
  topBar(doc, "Sorties & Flight Logging", 10);
  sectionTitle(doc, 48, 100, "Every sortie counted",
               "Logged once — used everywhere.", 500);

  const left = [
    ["One-minute sortie entry —", "pilot, co-pilot, mission type, day/night/NVG, seat timings (D1, D2, DD, N1, N2, ND)."],
    ["Inline edit, duplicate, delete —", "the whole squadron log, searchable and filterable."],
    ["Automatic validation —", "seat timings must add up to total flight time; typos caught before they save."],
    ["External & guest pilot logging —", "record visitors without adding them to the permanent roster."],
  ];
  const right = [
    ["Before/after diff —", "every edit or deletion shows exactly what changed, side by side."],
    ["Shake-to-undo —", "accidental delete? a single tap or gesture reverses it."],
    ["Pilot's mobile logbook —", "every pilot sees their own flight history in their pocket, always up to date."],
    ["Auditable for ever —", "Hawk Eye never forgets; the wing commander can audit any month, any year."],
  ];
  bulletList(doc, 48, 180, 360, left, { size: 10.5, gap: 5 });
  bulletList(doc, 430, 180, 360, right, { size: 10.5, gap: 5 });

  calloutBar(doc, 48, 470, 746, "HOURS THAT NEVER GET LOST",
    "A sortie logged on a pilot's phone at 14:02 is on the commander's dashboard, in the roster totals, and in next month's RCN form — all within seconds.");
  bottomBar(doc);
}

function pageCurrencies(doc) {
  bg(doc, NAVY);
  topBar(doc, "Currencies & Certifications", 11);
  sectionTitle(doc, 48, 100, "Nothing expires quietly",
               "Day, Night, NVG, IRT, Medical, Simulator.", 500);

  // Traffic-light panel
  const lights = [
    { c: "#2d8a5f", l: "CURRENT",        d: "ready to fly" },
    { c: "#b8860b", l: "EXPIRES SOON",   d: "act this month" },
    { c: "#b23a3a", l: "EXPIRED",        d: "grounded until renewed" },
    { c: "#555d7a", l: "NOT SET",        d: "never recorded; needs data" },
  ];
  lights.forEach((s, i) => {
    const x = 48 + i * 188;
    doc.roundedRect(x, 180, 176, 72, 8).fill(NAVY_SOFT);
    doc.roundedRect(x, 180, 176, 72, 8).lineWidth(0.7).strokeColor(GOLD_DIM).stroke();
    doc.circle(x + 18, 198, 8).fill(s.c);
    doc.fillColor(INK_HI).fontSize(11).font("Helvetica-Bold")
       .text(s.l, x + 34, 192, { lineBreak: false, characterSpacing: 1.5 });
    doc.fillColor(INK).fontSize(10).font("Helvetica")
       .text(s.d, x + 16, 214, { width: 152 });
  });

  bulletList(doc, 48, 280, 746, [
    ["Squadron-wide currency dashboard —", "a single colour-coded board for every pilot, every qualification, every expiry date."],
    ["Expired-after look-ahead —", "pick a future date; Hawk Eye shows who will fall out of currency by then — perfect for planning."],
    ["N/A toggle —", "pilots who do not fly NVG (or any category) are excluded cleanly — no false reds."],
    ["Fast IRT / Medical renewal —", "ops officers update a batch of pilots with two clicks."],
    ["Pilot's personal countdown —", "every pilot sees their own days-to-expiry on their phone, colour-coded."],
    ["Push reminders —", "at 30, 14 and 7 days before expiry, the pilot's phone nudges them — before it's a problem."],
  ], { size: 10.5, gap: 5 });

  bottomBar(doc);
}

function pageSchedule(doc) {
  bg(doc, NAVY);
  topBar(doc, "Schedule Sharing", 12);
  sectionTitle(doc, 48, 100, "From flight line to base HQ",
               "One schedule, shared up the chain.", 430);

  heroBox(doc, "schedule_chain", 440, 172, 354, 240);

  bulletList(doc, 48, 180, 380, [
    ["Daily mission board —", "the live flight line: aircraft, crew, takeoff/landing, mission type."],
    ["Four-tier chain —", "Flight → Squadron → Wing → Base. Each level can review, edit and approve before passing up."],
    ["Change diffing —", "when a schedule comes back with edits, Hawk Eye highlights exactly what changed — no hunting through the sheet."],
    ["RJAF-style flight sheet —", "digital replica of the official A4 landscape schedule, ready to print."],
    ["Program defaults —", "pre-set airbase, squadron name and standard aircraft types to draft the day's plan in minutes."],
  ], { size: 10, gap: 5 });

  calloutBar(doc, 48, 470, 746, "ONE VERSION OF TRUTH",
    "No more emailed PDFs or photocopies. Every tier sees the same live schedule — and knows whose turn it is to approve.");
  bottomBar(doc);
}

function pageMessaging(doc) {
  bg(doc, NAVY);
  topBar(doc, "Private Messages", 13);
  sectionTitle(doc, 48, 100, "A command-only inbox",
               "Secure PC-to-PC, priority-tagged.", 430);

  heroBox(doc, "private_messages", 440, 172, 354, 240);

  bulletList(doc, 48, 180, 380, [
    ["Private PC-to-PC —", "Wing → Squadron, Squadron → Flight — text-only, with a full audit trail."],
    ["Priority levels —", "Normal, High, Very High — and the receiving PC reacts accordingly."],
    ["Inbox, Sent, History —", "every message kept, searchable, never lost to a WhatsApp scroll."],
    ["Read receipts —", "the sender sees exactly when the commander on the other end opened the message."],
    ["Pilot broadcast —", "commanders can push short, urgent notices straight to a pilot's phone."],
  ], { size: 10, gap: 5 });

  calloutBar(doc, 48, 470, 746, "REPLACES WHATSAPP, BY DESIGN",
    "Command traffic stays inside the chain of command — not in a consumer chat app outside your control.");
  bottomBar(doc);
}

function pageAlerts(doc) {
  bg(doc, NAVY);
  topBar(doc, "Alerts", 14);
  sectionTitle(doc, 48, 100, "When it matters, you hear it",
               "Per-PC alerts with sound & pop-up.", 360);

  heroBox(doc, "network_nodes", 430, 150, 364, 240);

  body(doc, 48, 180, 360,
    "A commander shouldn't have to stare at the screen to catch an incoming " +
    "order. When a message, a schedule, or a cross-squadron approval lands " +
    "on a specific PC, Hawk Eye:",
    { size: 11, lineGap: 3 }
  );

  bulletList(doc, 48, 260, 360, [
    ["Plays an unmistakable tone", "on the receiving PC's speakers."],
    ["Flashes a clear pop-up",     "with the sender, the subject and a preview."],
    ["Fires a Windows notification","that surfaces even when another app is on top."],
  ], { size: 10.5 });

  doc.roundedRect(48, 430, 746, 90, 8).fill(NAVY_SOFT);
  doc.roundedRect(48, 430, 746, 90, 8).lineWidth(0.7).strokeColor(GOLD_DIM).stroke();
  doc.fillColor(GOLD).fontSize(10).font("Helvetica-Bold")
     .text("ONLY THE RIGHT PC CHIMES", 64, 442, { characterSpacing: 3, lineBreak: false });
  doc.fillColor(INK_HI).fontSize(11).font("Helvetica")
     .text("Other command posts stay silent — a wing PC does not chime when a " +
           "squadron sends a schedule to a different wing, other squadrons do " +
           "not chime on pending rows that are not theirs, and the sender is " +
           "never alerted on their own copy.  Signal, not noise.",
           64, 460, { width: 714, lineGap: 2 });
  bottomBar(doc);
}

function pageLeave(doc) {
  bg(doc, NAVY);
  topBar(doc, "Leave & Availability", 15);
  sectionTitle(doc, 48, 100, "Who can fly today?",
               "Leave, crew rest & unavailability.", 500);

  bulletList(doc, 48, 180, 360, [
    ["Daily availability —", "mark each pilot Available, on Leave, Sick, Crew Rest or any custom category, for a specific date."],
    ["Custom leave types —", "squadrons can add their own categories with chosen colours."],
    ["Weekly / monthly totals —", "leave days per pilot aggregated for long-range planning and Form 3."],
    ["Unavailability list —", "pilots out of the squadron today are flagged and excluded from scheduling."],
    ["Leave requests from the phone —", "a pilot submits a request; the commander approves on the PC — no paper form."],
  ], { size: 10.5, gap: 5 });

  const right = [
    { t: "Zero assignment mistakes", d: "The schedule form refuses to roster a pilot who is on sick leave today.", i: iconLeave },
    { t: "Form 3 in seconds",        d: "The monthly leave summary rolls up automatically from the daily availability.", i: iconReport },
    { t: "History never lost",       d: "Leave history stays with the pilot's record for every future audit.",        i: iconLog },
  ];
  right.forEach((r, i) => {
    const y = 180 + i * 104;
    card(doc, 430, y, 364, 92, r.t, r.d, r.i);
  });

  bottomBar(doc);
}

function pageReports(doc) {
  bg(doc, NAVY);
  topBar(doc, "Reports & Exports", 16);
  sectionTitle(doc, 48, 100, "One click to the signed form",
               "RCN Forms 1 – 4, PDFs, Excel.", 500);

  bulletList(doc, 48, 180, 360, [
    ["Monthly report wizard —", "auto-fills ORFG RCN Forms 1, 2, 3 and 4 from logged sorties and daily availability — no typing."],
    ["One-click PDFs —", "Authorization, Roster, Currency, Cycle, Risk and Totals reports with the RJAF emblem header."],
    ["Bilingual output —", "generate the same report in English, Arabic, or side-by-side bilingual."],
    ["Excel & CSV exports —", "hand the sortie log or roster to any spreadsheet tool for one-off analysis."],
    ["Mobile logbook export —", "a pilot can save a JSON copy of their personal flight history as a backup."],
    ["Arabic-Indic digits —", "printed Arabic reports use the correct numeric glyphs."],
  ], { size: 10.5, gap: 5 });

  const right = [
    { t: "Auth reports", i: iconReport },
    { t: "Roster",       i: iconBadge  },
    { t: "Currencies",   i: iconShield },
    { t: "Cycle",        i: iconChain  },
    { t: "Risk",         i: iconBell   },
    { t: "Totals",       i: iconLog    },
  ];
  right.forEach((r, i) => {
    const x = 430 + (i % 2) * 182;
    const y = 180 + Math.floor(i / 2) * 100;
    doc.roundedRect(x, y, 170, 88, 8).fill(NAVY_SOFT);
    doc.roundedRect(x, y, 170, 88, 8).lineWidth(0.7).strokeColor(GOLD_DIM).stroke();
    r.i(doc, x + 16, y + 16);
    doc.fillColor(GOLD_BRIGHT).fontSize(12).font("Helvetica-Bold")
       .text(r.t, x + 16, y + 56, { width: 140 });
    doc.fillColor(INK_DIM).fontSize(9).font("Helvetica")
       .text("one click · PDF · EN/AR", x + 16, doc.y + 2, { width: 140 });
  });

  bottomBar(doc);
}

function pageMultiTier(doc) {
  bg(doc, NAVY);
  topBar(doc, "Command Structure", 17);
  sectionTitle(doc, 48, 100, "Built for the chain of command",
               "Squadron, Wing, Base — with guests.", 500);

  bulletList(doc, 48, 180, 746, [
    ["Role-based views —", "Flight Commander, Squadron Commander, Wing, Base and HQ each see the tools they need — and nothing they shouldn't touch."],
    ["Multi-squadron view —", "Wing and Base commanders get a high-level readiness board for every squadron under their command."],
    ["Guest pilot backfill —", "when a visiting pilot flies with your squadron, the sortie lands as 'Pending Approval' on their home squadron's PC — automatically."],
    ["Military-number matching —", "guest sorties match the right pilot even across squadrons, regions and languages."],
    ["Guest seat cascading —", "once the home squadron accepts, the hours credit the correct pilot's record in a single step — no phone calls, no lost hours."],
    ["Terminal role lock —", "a terminal can be pinned to its role (e.g. 'Ops PC') so no one can silently change its scope."],
  ], { size: 10.5, gap: 5 });

  bottomBar(doc);
}

function pageMobile(doc) {
  bg(doc, NAVY);
  topBar(doc, "Pilot App", 18);
  const ruleY = sectionTitle(doc, 48, 100, "For pilots",
               "The logbook in every pilot's pocket.", 360);

  const imgTop = Math.max(172, ruleY + 10);
  heroBox(doc, "squadron_lineup", 430, imgTop, 364, 480 - imgTop);

  const feats = [
    ["Log a sortie in under a minute —", "taxi-out, taxi-in, mission type, remarks."],
    ["My hours, my currencies —",        "always up-to-date, at a glance."],
    ["Incoming alerts from command —",   "priority-tagged, impossible to miss."],
    ["Smart reminders —",                "before NVG, instrument or medical expire."],
    ["Leave requests —",                 "submit from the field, commander approves on PC."],
    ["Push notifications —",             "audible heads-up the moment a new order goes out."],
    ["Auto-unlock on cold launch —",     "trusted phone returns to ready instantly — no password on every open."],
    ["Works in English & Arabic —",      "full right-to-left layout."],
    ["Android & iOS —",                  "the same login, the same data, either device."],
  ];
  bulletList(doc, 48, ruleY + 24, 360, feats, { size: 10, gap: 4 });

  bottomBar(doc);
}

function pageSettings(doc) {
  bg(doc, NAVY);
  topBar(doc, "Bilingual · Offline · Settings", 19);
  sectionTitle(doc, 48, 100, "Designed for the squadron",
               "Bilingual, offline-tolerant, backed up.", 500);

  const items = [
    { t: "Bilingual EN / AR",  d: "Instant language toggle. UI layout flips automatically; pilot names and mission remarks can be entered in either script.", i: iconGlobe },
    { t: "Offline tolerant",   d: "If the network drops mid-sortie, entries queue safely on the PC or phone and sync the moment the connection returns.", i: iconOffline },
    { t: "Live sync indicator",d: "Every PC shows Online / Syncing / Offline — the operator always knows whether what they entered has reached the base.", i: iconCloud },
    { t: "Squadron setup",     d: "Squadron Name, Number and Base drive every report header — configure once, correct for ever.", i: iconBadge },
    { t: "Backup & restore",   d: "Create password-protected .rjafbackup files locally — a second copy outside the cloud, held by the squadron.", i: iconShield },
    { t: "Light & dark themes",d: "High-contrast mission colours for day operations; a darker palette suited to night-shift eyes.", i: iconCalendar },
  ];
  const cols = 3, rows = 2;
  const cw = (PAGE_W - 96 - (cols - 1) * 14) / cols;
  const ch = 160;
  items.forEach((it, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    card(doc, 48 + c * (cw + 14), 180 + r * (ch + 14), cw, ch, it.t, it.d, it.i);
  });

  bottomBar(doc);
}

function pageWhatItReplaces(doc) {
  bg(doc, NAVY);
  topBar(doc, "Before vs After", 20);
  sectionTitle(doc, 48, 100, "From paper to hawk-eyed",
               "What Hawk Eye replaces.", 500);

  const rows = [
    ["Paper logbooks in a drawer",              "A live, searchable electronic logbook on every device."],
    ["WhatsApp groups for schedule changes",    "Private PC-to-PC messages, audited and priority-tagged."],
    ["Manually typed monthly reports",          "Auto-generated RCN Forms 1 – 4, bilingual, PDF-ready."],
    ["Forgotten currency expirations",          "Reminders before each pilot's next expiry."],
    ["Guest-pilot hours lost between squadrons","Automatic cross-squadron approval flow."],
    ["Phone calls to confirm the latest schedule","Shared schedule chain — everyone sees the same version."],
    ["Scattered leave slips",                   "One daily availability board feeding the monthly Form 3."],
  ];

  const leftX = 60, rightX = 430, rowH = 46, topY = 190;
  doc.fillColor(GOLD).fontSize(10).font("Helvetica-Bold")
     .text("YESTERDAY", leftX, topY - 22, { characterSpacing: 3, lineBreak: false })
     .text("WITH HAWK EYE", rightX, topY - 22, { characterSpacing: 3, lineBreak: false });

  rows.forEach((r, i) => {
    const y = topY + i * rowH;
    doc.roundedRect(48, y, 360, rowH - 8, 6).fill(NAVY_SOFT)
       .roundedRect(48, y, 360, rowH - 8, 6).lineWidth(0.5).strokeColor(GOLD_DIM).stroke();
    doc.fillColor(INK).fontSize(10.5).font("Helvetica")
       .text(r[0], 60, y + 11, { width: 336, lineGap: 2 });

    doc.save();
    const ay = y + (rowH - 8) / 2;
    doc.moveTo(415, ay).lineTo(425, ay).lineTo(420, ay - 4).moveTo(425, ay).lineTo(420, ay + 4)
       .lineWidth(1.2).strokeColor(GOLD).stroke();
    doc.restore();

    doc.roundedRect(430, y, 364, rowH - 8, 6).fill(NAVY_SOFT)
       .roundedRect(430, y, 364, rowH - 8, 6).lineWidth(0.5).strokeColor(GOLD).stroke();
    doc.fillColor(INK_HI).fontSize(10.5).font("Helvetica-Bold")
       .text(r[1], 442, y + 11, { width: 340, lineGap: 2 });
  });

  bottomBar(doc);
}

function pageClosing(doc) {
  bg(doc, NAVY_DEEP);
  vignette(doc);

  doc.image(EMBLEM, PAGE_W / 2 - 45, 110, { width: 90 });

  doc.fillColor(GOLD).fontSize(11).font("Helvetica-Bold")
     .text("HAWK EYE", 0, 220, { width: PAGE_W, align: "center", characterSpacing: 6 });
  doc.fillColor(INK_HI).fontSize(32).font("Helvetica-Bold")
     .text("Sharper eyes. Stronger squadron.", 0, 245, { width: PAGE_W, align: "center" });
  doc.fillColor(INK).fontSize(14).font("Helvetica")
     .text("Every sortie counted. Every pilot ready. Every commander informed.",
           0, 295, { width: PAGE_W, align: "center" });

  const chips = ["Windows Desktop", "Android & iOS", "Bilingual EN / AR",
                 "Two-factor login", "Encrypted end-to-end", "Full audit trail",
                 "Offline-tolerant", "Guest-pilot aware"];
  let cx = 60, cy = 360;
  doc.fontSize(9).font("Helvetica-Bold");
  for (const c of chips) {
    const w = doc.widthOfString(c) + 24;
    if (cx + w > PAGE_W - 60) { cx = 60; cy += 34; }
    doc.roundedRect(cx, cy, w, 24, 12).lineWidth(0.8).strokeColor(GOLD).stroke();
    doc.fillColor(GOLD).text(c, cx + 12, cy + 7, { lineBreak: false, characterSpacing: 1.2 });
    cx += w + 8;
  }

  doc.moveTo(PAGE_W / 2 - 40, PAGE_H - 120).lineTo(PAGE_W / 2 + 40, PAGE_H - 120)
     .lineWidth(1.5).strokeColor(GOLD).stroke();
  doc.fillColor(INK_DIM).fontSize(10).font("Helvetica")
     .text("Royal Jordanian Air Force  ·  Squadron Operations",
           0, PAGE_H - 108, { width: PAGE_W, align: "center" });
  doc.fillColor(INK_DIM).fontSize(9).font("Helvetica-Oblique")
     .text(`Prepared for command review  ·  Version ${VERSION}  ·  April 2026`,
           0, PAGE_H - 88, { width: PAGE_W, align: "center" });
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

fs.mkdirSync(path.dirname(OUT), { recursive: true });

const doc = new PDFDocument({
  size: [PAGE_W, PAGE_H],
  margin: 0,
  info: {
    Title: "Hawk Eye — Digital Squadron Operations",
    Author: "Royal Jordanian Air Force",
    Subject: "Command Briefing",
  },
});
doc.pipe(fs.createWriteStream(OUT));

pageCover(doc);
doc.addPage(); pageContents(doc);
doc.addPage(); pageWhatIs(doc);
doc.addPage(); pageEcosystem(doc);
doc.addPage(); pageDataFlow(doc);
doc.addPage(); pageSecurity(doc);
doc.addPage(); pageDefence(doc);
doc.addPage(); pageDashboard(doc);
doc.addPage(); pageRoster(doc);
doc.addPage(); pageSorties(doc);
doc.addPage(); pageCurrencies(doc);
doc.addPage(); pageSchedule(doc);
doc.addPage(); pageMessaging(doc);
doc.addPage(); pageAlerts(doc);
doc.addPage(); pageLeave(doc);
doc.addPage(); pageReports(doc);
doc.addPage(); pageMultiTier(doc);
doc.addPage(); pageMobile(doc);
doc.addPage(); pageSettings(doc);
doc.addPage(); pageWhatItReplaces(doc);
doc.addPage(); pageClosing(doc);

doc.end();

await new Promise(res => doc.on("end", res));
const stat = fs.statSync(OUT);
console.log(`wrote ${OUT} (${(stat.size / 1024).toFixed(1)} KB)`);
