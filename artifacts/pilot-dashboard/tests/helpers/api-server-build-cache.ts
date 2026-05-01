// Cache the compiled api-server bundle across multi-PC test reruns so a
// developer iterating only pays the ~30-45s esbuild cost when something
// in `artifacts/api-server` actually changed.
//
// Cache key = sha256 of every `src/**/*.ts` file plus `package.json` and
// `build.mjs` for the api-server, AND every `src/**/*.ts` + `package.json`
// for each workspace lib under `<repoRoot>/lib/*`. The lib coverage was
// added after #404: editing `lib/api-zod/src/*.ts` used to leave a stale
// bundle around (the build inlines the lib via esbuild, but the cache
// did not know that), and the multi-PC test would silently exercise the
// previous lib version. Cache layout mirrors a finished build directory
// at `<cacheRoot>/<sha>/` (index.mjs + pino worker shims + .map files),
// so we can point the spawned api-server child straight at it without
// copying anything back into `artifacts/api-server/dist`.
//
// Manual cache nuke: `rm -rf node_modules/.cache/multi-pc-test-build`.

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

export type EnsureBuiltOpts = {
  /** Absolute path to `artifacts/api-server`. */
  apiServerDir: string;
  /** Where cached bundles live, e.g. `node_modules/.cache/multi-pc-test-build`. */
  cacheRoot: string;
  /** Absolute path to the api-server's `dist` output dir (build target). */
  destDist: string;
  /**
   * Synchronous build hook. Called only on cache miss. Must populate
   * `destDist` with `index.mjs` (+ pino shims) and throw on failure.
   */
  build: () => void;
  /**
   * Optional: where to look for workspace libs whose source contributes
   * to the bundle. Defaults to `<apiServerDir>/../../lib`. Pass a custom
   * dir from unit tests so they can run against a fixture filesystem.
   */
  libsRoot?: string;
};

export type EnsureBuiltResult = {
  /** Directory containing `index.mjs` to spawn the api-server from. */
  distDir: string;
  /** True if the cached bundle was reused. */
  cacheHit: boolean;
  /** sha256 cache key the lookup resolved to. */
  cacheKey: string;
};

function listSourceFiles(srcDir: string): string[] {
  const out: string[] = [];
  const stack = [srcDir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let ents;
    try {
      ents = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile() && p.endsWith(".ts")) {
        out.push(p);
      }
    }
  }
  return out.sort();
}

function defaultLibsRoot(apiServerDir: string): string {
  // <repoRoot>/artifacts/api-server → <repoRoot>/lib
  return resolve(apiServerDir, "..", "..", "lib");
}

function listLibInputs(libsRoot: string): string[] {
  const out: string[] = [];
  let libEnts;
  try {
    libEnts = readdirSync(libsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const lib of libEnts) {
    if (!lib.isDirectory()) continue;
    const libDir = join(libsRoot, lib.name);
    const pkg = join(libDir, "package.json");
    if (existsSync(pkg)) out.push(pkg);
    const srcDir = join(libDir, "src");
    if (existsSync(srcDir)) out.push(...listSourceFiles(srcDir));
  }
  return out;
}

/**
 * Deterministic sha256 over api-server build inputs. Exposed for the
 * cache-invalidation smoke test in
 * `tests/api-server-build-cache.test.ts`.
 *
 * Inputs covered:
 *   - `<apiServerDir>/src/**\/*.ts`
 *   - `<apiServerDir>/package.json` and `build.mjs`
 *   - For every workspace lib `<libsRoot>/<lib>`:
 *     - `<libsRoot>/<lib>/package.json`
 *     - `<libsRoot>/<lib>/src/**\/*.ts`
 *
 * `libsRoot` defaults to `<apiServerDir>/../../lib`. Pass an explicit
 * `libsRoot` from unit tests that build a fixture filesystem.
 */
export function computeApiServerCacheKey(
  apiServerDir: string,
  libsRoot: string = defaultLibsRoot(apiServerDir),
): string {
  const srcDir = join(apiServerDir, "src");
  const apiFiles: string[] = listSourceFiles(srcDir);
  for (const extra of ["package.json", "build.mjs"]) {
    const p = join(apiServerDir, extra);
    if (existsSync(p)) apiFiles.push(p);
  }
  const hash = createHash("sha256");
  // Hash the api-server inputs first, namespaced by repo-relative-ish path
  // (relative to apiServerDir for back-compat).
  for (const f of apiFiles) {
    hash.update(`api:${relative(apiServerDir, f)}`);
    hash.update("\0");
    hash.update(readFileSync(f));
    hash.update("\0");
  }
  // Then the workspace libs, namespaced by lib path so reordering on
  // disk does not perturb the hash.
  const libFiles = listLibInputs(libsRoot).sort();
  for (const f of libFiles) {
    hash.update(`lib:${relative(libsRoot, f)}`);
    hash.update("\0");
    hash.update(readFileSync(f));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function copyDirSync(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) copyDirSync(s, d);
    else if (e.isFile()) copyFileSync(s, d);
  }
}

/**
 * Look up the cached bundle for the current api-server source state. On
 * cache miss, run `opts.build()` and atomically promote its output into
 * `<cacheRoot>/<sha>/`. Returns the dist dir to spawn from.
 */
export function ensureApiServerBuiltCached(
  opts: EnsureBuiltOpts,
): EnsureBuiltResult {
  const cacheKey = computeApiServerCacheKey(
    opts.apiServerDir,
    opts.libsRoot ?? defaultLibsRoot(opts.apiServerDir),
  );
  const cachedDir = join(opts.cacheRoot, cacheKey);
  const cachedEntry = join(cachedDir, "index.mjs");
  if (existsSync(cachedEntry)) {
    return { distDir: cachedDir, cacheHit: true, cacheKey };
  }

  opts.build();
  if (!existsSync(join(opts.destDist, "index.mjs"))) {
    throw new Error(
      "api-server build did not produce dist/index.mjs — refusing to cache",
    );
  }

  // Atomic promote: copy to a sibling tmp dir, then rename onto the
  // cache slot. Two concurrent test runs racing the same key both end
  // up with a valid bundle either way; rename is atomic on the same fs.
  mkdirSync(opts.cacheRoot, { recursive: true });
  const tmp = `${cachedDir}.tmp-${process.pid}-${Date.now()}`;
  rmSync(tmp, { recursive: true, force: true });
  copyDirSync(opts.destDist, tmp);
  rmSync(cachedDir, { recursive: true, force: true });
  renameSync(tmp, cachedDir);
  return { distDir: cachedDir, cacheHit: false, cacheKey };
}
