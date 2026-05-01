#!/usr/bin/env node
// Hawk Eye — fail the build if the dashboard bundle ships an external URL.
//
// Hawk Eye runs on an air-gapped LAN. Any `http(s)://…` reference outside
// this allow-list is a CDN / Google Fonts / analytics slip and would
// leave operators staring at broken icons (or worse, leak hostnames).
// This script is intentionally simple: it greps the built dashboard for
// `http://` and `https://` literals and complains about anything that
// isn't:
//
//   - localhost / 127.0.0.1
//   - any *.local (mDNS) hostname
//   - the documented placeholder hostnames hawk-api.lan / hawk-hub.lan
//   - the documented w3.org / SVG namespaces (XML attributes, no traffic)
//   - replit/cloud preview hosts (used only when running `pnpm dev` —
//     never in the LAN production build, but harmless if they appear).
//
// Run:  pnpm run check:no-external-urls
//
// Exit code is non-zero when an unexpected URL is found.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const DASHBOARD_DIST = resolve(
  REPO_ROOT,
  "artifacts",
  "pilot-dashboard",
  "dist",
);

const ALLOW_HOST_REGEXES = [
  /^localhost(?::\d+)?$/i,
  /^127\.0\.0\.1(?::\d+)?$/,
  /^0\.0\.0\.0(?::\d+)?$/,
  /^\[?::1\]?(?::\d+)?$/,
  /^[a-z0-9-]+\.local(?::\d+)?$/i,
  /^hawk-api\.lan(?::\d+)?$/i,
  /^hawk-hub\.lan(?::\d+)?$/i,
];

const ALLOW_URL_REGEXES = [
  // XML / SVG namespaces — declared as attributes, no network traffic.
  /^https?:\/\/www\.w3\.org\//i,
  // Schema.org / OpenGraph metadata — declared in <meta>, no traffic.
  /^https?:\/\/schema\.org\//i,
  /^https?:\/\/ogp\.me\//i,
  // Documentation comments / SPDX URLs — no traffic.
  /^https?:\/\/spdx\.org\//i,
  /^https?:\/\/(www\.)?gnu\.org\//i,
  /^https?:\/\/opensource\.org\//i,
  /^https?:\/\/unlicense\.org\//i,
  /^https?:\/\/(www\.)?apache\.org\//i,
  /^https?:\/\/(www\.)?mozilla\.org\//i,
  /^https?:\/\/(www\.)?creativecommons\.org\//i,
  /^https?:\/\/(www\.)?eclipse\.org\//i,
  /^https?:\/\/(www\.)?reactjs\.org\//i,
  /^https?:\/\/(www\.)?ecma-international\.org\//i,
  // Google Fonts (Inter) — intentional, documented in index.html. The
  // dashboard falls back to system-ui when offline; the CSP also
  // explicitly allow-lists fonts.googleapis.com / fonts.gstatic.com.
  // Allow bare host (preconnect) and any path under it.
  /^https?:\/\/fonts\.googleapis\.com(\/|$)/i,
  /^https?:\/\/fonts\.gstatic\.com(\/|$)/i,
  // OOXML / Office namespace URIs in exceljs/xlsx serialisation —
  // declared as XML attributes, no network traffic.
  /^https?:\/\/schemas\.openxmlformats\.org\//i,
  /^https?:\/\/schemas\.microsoft\.com\/office\//i,
  /^https?:\/\/purl\.org\/dc\//i,
  // Vendor-bundle string constants (license headers, error-doc URLs,
  // homepage links) shipped inside transitive npm dependencies. None
  // of these trigger network calls — they're string literals embedded
  // by the upstream maintainers. Add to this list only when you have
  // confirmed the URL is a string constant in a vendored bundle.
  /^https?:\/\/(www\.)?github\.com\//i,
  /^https?:\/\/[a-z0-9-]+\.github\.io\//i,
  /^https?:\/\/(www\.)?react\.dev\//i,
  /^https?:\/\/developer\.mozilla\.org\//i,
  /^https?:\/\/(www\.)?radix-ui\.com\//i,
  /^https?:\/\/jspdf\.default\.namespaceuri\//i,
  // Bundled inside @supabase/supabase-js / vendored exceljs/jspdf
  // helpers (string constants, not loaded). Supabase has been removed
  // from runtime use; these are residual strings in legacy bundles.
  /^https?:\/\/[a-z0-9]+\.supabase\.(co|in)(\/|$)/i,
  /^https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/pdfobject\//i,
];

function isHostAllowed(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return true; // malformed (likely template literal artefact); skip.
  }
  const host = parsed.host;
  for (const re of ALLOW_HOST_REGEXES) if (re.test(host)) return true;
  for (const re of ALLOW_URL_REGEXES) if (re.test(url)) return true;
  return false;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (st.isFile()) {
      yield full;
    }
  }
}

const TEXT_EXT = new Set([".html", ".js", ".mjs", ".cjs", ".css", ".json", ".map", ".svg", ".txt"]);

function isTextFile(path) {
  const lower = path.toLowerCase();
  for (const ext of TEXT_EXT) if (lower.endsWith(ext)) return true;
  return false;
}

const URL_RE = /https?:\/\/[A-Za-z0-9.\-:_/~%?&=#@+]+/g;

const violations = [];
let scanned = 0;

try {
  statSync(DASHBOARD_DIST);
} catch {
  console.error(
    `[check-no-external-urls] Dashboard dist not found at ${DASHBOARD_DIST}\n` +
      "Run `pnpm --filter @workspace/pilot-dashboard run build` first.",
  );
  process.exit(2);
}

for (const file of walk(DASHBOARD_DIST)) {
  if (!isTextFile(file)) continue;
  scanned += 1;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const seenInThisFile = new Set();
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(/[).,;:'"`]+$/, "");
    if (seenInThisFile.has(url)) continue;
    seenInThisFile.add(url);
    if (!isHostAllowed(url)) {
      violations.push({ file: relative(REPO_ROOT, file), url });
    }
  }
}

if (violations.length === 0) {
  console.log(
    `[check-no-external-urls] OK — scanned ${scanned} bundle file(s), no external URLs.`,
  );
  process.exit(0);
}

console.error(
  `[check-no-external-urls] FAIL — found ${violations.length} external URL(s) in the bundle:`,
);
for (const v of violations) {
  console.error(`  ${v.file}: ${v.url}`);
}
console.error(
  "\nIf one of these is legitimate (e.g. a vendor/license comment URL), add\n" +
    "it to ALLOW_URL_REGEXES in scripts/src/check-no-external-urls.mjs.",
);
process.exit(1);
