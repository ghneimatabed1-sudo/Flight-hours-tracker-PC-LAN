// Combined ESM loader hook for the wizards e2e test (Task #375).
//
// Three responsibilities, kept in one file so a single `--import`
// registers everything the test needs:
//
//  1. Stub static-asset and CSS imports the same way `asset-loader.mjs`
//     does, so any UI component pulled in by a wizard can load under
//     plain Node without a Vite asset pipeline.
//
//  2. Patch `internal-migration.ts` so its module-scope reference to
//     `import.meta.env` is rewritten to `globalThis.__HAWK_TEST_VITE_ENV`.
//     The test sets that global before any dashboard module imports,
//     which lets the LAN/internal helpers resolve real URLs via
//     `VITE_INTERNAL_API_URL` and hit our mocked `globalThis.fetch`.
//
//  3. Same rewrite for `unit-join.ts` — its SUPABASE_URL / ANON_KEY /
//     JOIN_SECRET module-level consts are read from `import.meta.env`
//     at first import. SetupWizard's `unitJoinConfigured` flag is also
//     evaluated at import time, so the env MUST be present before the
//     module is loaded.
//
// This loader is TEST-ONLY — never used by Vite or production builds.

const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|ico|avif)(\?.*)?$/i;
const CSS_RE = /\.css(\?.*)?$/i;

const PATCH_PATHS = [
  "/lib/internal-migration.ts",
  "/lib/unit-join.ts",
];

export async function load(url, context, nextLoad) {
  if (ASSET_RE.test(url)) {
    return {
      format: "module",
      shortCircuit: true,
      source: `export default ${JSON.stringify(url)};`,
    };
  }
  if (CSS_RE.test(url)) {
    return {
      format: "module",
      shortCircuit: true,
      source: "export default {};",
    };
  }
  if (PATCH_PATHS.some((p) => url.endsWith(p))) {
    const result = await nextLoad(url, context);
    let src = result.source == null ? "" : String(result.source);
    // Same trick as peer-tokens-page-loader: a plain string substitution
    // turns every `import.meta.env` reference into a live read of
    // `globalThis.__HAWK_TEST_VITE_ENV`. The test seeds that object
    // BEFORE these modules are imported and may mutate properties on it
    // between sub-tests to flip e.g. `VITE_LAN_SESSION_LOGIN` on and off.
    src = src.split("import.meta.env").join("globalThis.__HAWK_TEST_VITE_ENV");
    return { ...result, source: src };
  }
  return nextLoad(url, context);
}

export async function resolve(specifier, context, nextResolve) {
  return nextResolve(specifier, context);
}
