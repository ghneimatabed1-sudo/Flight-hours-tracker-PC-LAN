// Pin the absence of retired multi-PC-mesh page + route files so a
// future barrel re-export can't silently resurrect the deleted code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");

const DELETED_PAGES = [
  "artifacts/pilot-dashboard/src/pages/PendingApprovals.tsx",
  "artifacts/pilot-dashboard/src/pages/ScheduleChain.tsx",
  "artifacts/pilot-dashboard/src/pages/ScheduleHistory.tsx",
  "artifacts/pilot-dashboard/src/pages/FinalSchedules.tsx",
  "artifacts/pilot-dashboard/src/pages/Messages.tsx",
  "artifacts/pilot-dashboard/src/pages/Connections.tsx",
  "artifacts/pilot-dashboard/src/pages/Diagnostic.tsx",
  "artifacts/pilot-dashboard/src/pages/FlightProgram.tsx",
  "artifacts/pilot-dashboard/src/pages/Reminders.tsx",
  "artifacts/pilot-dashboard/src/pages/admin/RemindersSchedule.tsx",
  "artifacts/pilot-dashboard/src/pages/admin/ConnectionMap.tsx",
];

const DELETED_ROUTES = [
  "artifacts/api-server/src/routes/pilot-links-internal.ts",
  "artifacts/api-server/src/routes/lan-users-reminders.ts",
];

test("retired page files are absent", () => {
  const present: string[] = [];
  for (const rel of DELETED_PAGES) {
    if (existsSync(resolve(REPO_ROOT, rel))) present.push(rel);
  }
  assert.deepEqual(
    present,
    [],
    `retired pages still present on disk: ${present.join(", ")}`,
  );
});

test("retired api-server routes are absent", () => {
  const present: string[] = [];
  for (const rel of DELETED_ROUTES) {
    if (existsSync(resolve(REPO_ROOT, rel))) present.push(rel);
  }
  assert.deepEqual(
    present,
    [],
    `retired routes still present on disk: ${present.join(", ")}`,
  );
});

test("Layout.tsx and HQLayout.tsx have no live references to deleted pages", () => {
  const layout = readFileSync(
    resolve(REPO_ROOT, "artifacts/pilot-dashboard/src/components/Layout.tsx"),
    "utf-8",
  );
  const hq = readFileSync(
    resolve(REPO_ROOT, "artifacts/pilot-dashboard/src/components/HQLayout.tsx"),
    "utf-8",
  );
  const haystack = `${layout}\n${hq}`;
  // Strip line comments + block comments before searching so a
  // historical "// retired with #339" comment never trips the check.
  const stripped = haystack
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  // Sidebar registers each entry by route path. Pin those.
  const FORBIDDEN_PATHS = [
    "/pending",
    "/schedule-chain",
    "/schedule-history",
    "/final-schedules",
    "/messages",
    "/connections",
    "/diagnostic",
    "/flight-program",
    "/reminders",
    "/admin/reminders",
    "/admin/connection-map",
  ];
  const hits = FORBIDDEN_PATHS.filter((p) => {
    const re = new RegExp(`["\\\`']${p}["\\\`']`);
    return re.test(stripped);
  });
  assert.deepEqual(
    hits,
    [],
    `sidebars still reference retired routes: ${hits.join(", ")}`,
  );
});

test("App.tsx has no live <Route> for deleted pages", () => {
  const app = readFileSync(
    resolve(REPO_ROOT, "artifacts/pilot-dashboard/src/App.tsx"),
    "utf-8",
  );
  const stripped = app
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const FORBIDDEN_COMPONENTS = [
    "PendingApprovals",
    "ScheduleChain",
    "ScheduleHistory",
    "FinalSchedules",
    "Messages",
    "Connections",
    "Diagnostic",
    "FlightProgram",
    // `Reminders` would clash with substrings; check the import path instead.
  ];
  const hits = FORBIDDEN_COMPONENTS.filter((c) => {
    const re = new RegExp(`component=\\{${c}\\}`);
    return re.test(stripped);
  });
  assert.deepEqual(
    hits,
    [],
    `App.tsx still mounts retired pages: ${hits.join(", ")}`,
  );
  // Reminders / RemindersSchedule / ConnectionMap import paths.
  for (const path of [
    "src/pages/Reminders",
    "src/pages/admin/RemindersSchedule",
    "src/pages/admin/ConnectionMap",
  ]) {
    assert.ok(
      !stripped.includes(path),
      `App.tsx still imports retired page ${path}`,
    );
  }
});
