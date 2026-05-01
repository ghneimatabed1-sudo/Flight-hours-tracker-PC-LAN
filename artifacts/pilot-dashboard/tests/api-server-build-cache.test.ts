// Smoke test for the api-server build cache that backs the multi-PC
// real-process test. Spec: when an api-server source file changes the
// cache key changes (cache miss → real build runs); when nothing
// changes the cache key is stable (cache hit → build is skipped).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeApiServerCacheKey,
  ensureApiServerBuiltCached,
} from "./helpers/api-server-build-cache";

type Fixture = {
  root: string;
  apiServerDir: string;
  cacheRoot: string;
  destDist: string;
  libsRoot: string;
  cleanup: () => void;
};

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "build-cache-test-"));
  const apiServerDir = join(root, "api-server");
  const cacheRoot = join(root, ".cache");
  const destDist = join(apiServerDir, "dist");
  const libsRoot = join(root, "lib");
  mkdirSync(join(apiServerDir, "src", "lib"), { recursive: true });
  writeFileSync(
    join(apiServerDir, "package.json"),
    JSON.stringify({ name: "fake", version: "0.0.0" }),
  );
  writeFileSync(join(apiServerDir, "build.mjs"), "// fake build script\n");
  writeFileSync(join(apiServerDir, "src", "index.ts"), "export const x = 1;\n");
  writeFileSync(
    join(apiServerDir, "src", "lib", "util.ts"),
    "export const y = 2;\n",
  );
  // Two stand-in workspace libs so the new lib-walking branch is
  // exercised without touching the real `<repoRoot>/lib`.
  mkdirSync(join(libsRoot, "alpha", "src", "deep"), { recursive: true });
  writeFileSync(
    join(libsRoot, "alpha", "package.json"),
    JSON.stringify({ name: "@workspace/alpha", version: "1.0.0" }),
  );
  writeFileSync(
    join(libsRoot, "alpha", "src", "index.ts"),
    "export const a = 1;\n",
  );
  writeFileSync(
    join(libsRoot, "alpha", "src", "deep", "util.ts"),
    "export const a2 = 2;\n",
  );
  mkdirSync(join(libsRoot, "beta", "src"), { recursive: true });
  writeFileSync(
    join(libsRoot, "beta", "package.json"),
    JSON.stringify({ name: "@workspace/beta", version: "1.0.0" }),
  );
  writeFileSync(
    join(libsRoot, "beta", "src", "index.ts"),
    "export const b = 1;\n",
  );
  return {
    root,
    apiServerDir,
    cacheRoot,
    destDist,
    libsRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function fakeBuild(destDist: string): () => void {
  return () => {
    mkdirSync(destDist, { recursive: true });
    writeFileSync(join(destDist, "index.mjs"), "// built bundle\n");
    writeFileSync(
      join(destDist, "pino-worker.mjs"),
      "// pino worker shim\n",
    );
  };
}

test("computeApiServerCacheKey is deterministic across calls", () => {
  const f = makeFixture();
  try {
    const a = computeApiServerCacheKey(f.apiServerDir, f.libsRoot);
    const b = computeApiServerCacheKey(f.apiServerDir, f.libsRoot);
    assert.equal(a, b, "key must be stable when nothing changes");
    assert.match(a, /^[0-9a-f]{64}$/);
  } finally {
    f.cleanup();
  }
});

test("computeApiServerCacheKey changes when a src/**/*.ts file changes", () => {
  const f = makeFixture();
  try {
    const before = computeApiServerCacheKey(f.apiServerDir, f.libsRoot);
    writeFileSync(
      join(f.apiServerDir, "src", "lib", "util.ts"),
      "export const y = 999;\n",
    );
    const after = computeApiServerCacheKey(f.apiServerDir, f.libsRoot);
    assert.notEqual(before, after, "touching a src .ts must invalidate");
  } finally {
    f.cleanup();
  }
});

test("computeApiServerCacheKey changes when package.json changes", () => {
  const f = makeFixture();
  try {
    const before = computeApiServerCacheKey(f.apiServerDir, f.libsRoot);
    writeFileSync(
      join(f.apiServerDir, "package.json"),
      JSON.stringify({ name: "fake", version: "0.0.1" }),
    );
    const after = computeApiServerCacheKey(f.apiServerDir, f.libsRoot);
    assert.notEqual(before, after, "package.json change must invalidate");
  } finally {
    f.cleanup();
  }
});

test("computeApiServerCacheKey changes when a workspace lib's src/*.ts changes (#406)", () => {
  // Regression for #404: editing `lib/api-zod/src/*.ts` left a stale
  // bundle in the cache because the key only hashed api-server source.
  // Touching any lib source — at any depth — must now invalidate.
  const f = makeFixture();
  try {
    const before = computeApiServerCacheKey(f.apiServerDir, f.libsRoot);
    writeFileSync(
      join(f.libsRoot, "alpha", "src", "deep", "util.ts"),
      "export const a2 = 999;\n",
    );
    const after = computeApiServerCacheKey(f.apiServerDir, f.libsRoot);
    assert.notEqual(
      before,
      after,
      "touching a lib's nested src .ts must invalidate",
    );
  } finally {
    f.cleanup();
  }
});

test("computeApiServerCacheKey changes when a workspace lib's package.json changes (#406)", () => {
  const f = makeFixture();
  try {
    const before = computeApiServerCacheKey(f.apiServerDir, f.libsRoot);
    writeFileSync(
      join(f.libsRoot, "beta", "package.json"),
      JSON.stringify({ name: "@workspace/beta", version: "2.0.0" }),
    );
    const after = computeApiServerCacheKey(f.apiServerDir, f.libsRoot);
    assert.notEqual(
      before,
      after,
      "version bump in a lib package.json must invalidate",
    );
  } finally {
    f.cleanup();
  }
});

test("computeApiServerCacheKey is unaffected by non-.ts files inside a lib (#406)", () => {
  const f = makeFixture();
  try {
    const before = computeApiServerCacheKey(f.apiServerDir, f.libsRoot);
    writeFileSync(
      join(f.libsRoot, "alpha", "src", "README.md"),
      "should not be hashed\n",
    );
    writeFileSync(
      join(f.libsRoot, "alpha", "src", "data.json"),
      "{}\n",
    );
    const after = computeApiServerCacheKey(f.apiServerDir, f.libsRoot);
    assert.equal(
      before,
      after,
      "non-.ts files in lib src must not perturb the cache key",
    );
  } finally {
    f.cleanup();
  }
});

test("computeApiServerCacheKey tolerates an absent libsRoot (#406)", () => {
  // Some test fixtures don't populate `<root>/lib` at all; the helper
  // must degrade gracefully rather than throw ENOENT.
  const f = makeFixture();
  try {
    rmSync(f.libsRoot, { recursive: true, force: true });
    const k = computeApiServerCacheKey(f.apiServerDir, f.libsRoot);
    assert.match(k, /^[0-9a-f]{64}$/);
  } finally {
    f.cleanup();
  }
});

test("ensureApiServerBuiltCached: cold → build runs; warm → build skipped", () => {
  const f = makeFixture();
  try {
    let buildCalls = 0;
    const build = (): void => {
      buildCalls++;
      fakeBuild(f.destDist)();
    };

    const first = ensureApiServerBuiltCached({
      apiServerDir: f.apiServerDir,
      libsRoot: f.libsRoot,
      cacheRoot: f.cacheRoot,
      destDist: f.destDist,
      build,
    });
    assert.equal(buildCalls, 1, "cold cache must build once");
    assert.equal(first.cacheHit, false);
    assert.ok(
      existsSync(join(first.distDir, "index.mjs")),
      "cached dist must contain index.mjs",
    );
    assert.ok(
      existsSync(join(first.distDir, "pino-worker.mjs")),
      "auxiliary bundle files must be cached too",
    );

    const second = ensureApiServerBuiltCached({
      apiServerDir: f.apiServerDir,
      libsRoot: f.libsRoot,
      cacheRoot: f.cacheRoot,
      destDist: f.destDist,
      build,
    });
    assert.equal(buildCalls, 1, "warm cache must skip the build");
    assert.equal(second.cacheHit, true);
    assert.equal(second.distDir, first.distDir, "same key → same dir");
  } finally {
    f.cleanup();
  }
});

test("ensureApiServerBuiltCached: source change invalidates and rebuilds", () => {
  const f = makeFixture();
  try {
    let buildCalls = 0;
    const build = (): void => {
      buildCalls++;
      fakeBuild(f.destDist)();
    };

    const first = ensureApiServerBuiltCached({
      apiServerDir: f.apiServerDir,
      libsRoot: f.libsRoot,
      cacheRoot: f.cacheRoot,
      destDist: f.destDist,
      build,
    });
    assert.equal(buildCalls, 1);

    // No-op rerun: still 1.
    ensureApiServerBuiltCached({
      apiServerDir: f.apiServerDir,
      libsRoot: f.libsRoot,
      cacheRoot: f.cacheRoot,
      destDist: f.destDist,
      build,
    });
    assert.equal(buildCalls, 1, "second run with no changes hits cache");

    // Touch a source file → next call must rebuild.
    writeFileSync(
      join(f.apiServerDir, "src", "lib", "util.ts"),
      "export const y = 42;\n",
    );
    const after = ensureApiServerBuiltCached({
      apiServerDir: f.apiServerDir,
      libsRoot: f.libsRoot,
      cacheRoot: f.cacheRoot,
      destDist: f.destDist,
      build,
    });
    assert.equal(buildCalls, 2, "source change must trigger rebuild");
    assert.equal(after.cacheHit, false);
    assert.notEqual(after.distDir, first.distDir, "new key → new dir");

    // And then another no-op rerun hits the new cache slot.
    ensureApiServerBuiltCached({
      apiServerDir: f.apiServerDir,
      libsRoot: f.libsRoot,
      cacheRoot: f.cacheRoot,
      destDist: f.destDist,
      build,
    });
    assert.equal(buildCalls, 2, "rebuild result is itself cached");
  } finally {
    f.cleanup();
  }
});
