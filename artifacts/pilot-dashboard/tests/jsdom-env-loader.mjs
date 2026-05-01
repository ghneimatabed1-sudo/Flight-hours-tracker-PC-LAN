// Combined ESM loader hook for the jsdom-based component tests added
// in Task #406 (T-L). Two responsibilities, kept in one file so a
// single `--import` registers everything the tests need:
//
//  1. Stub static-asset and CSS imports the same way `asset-loader.mjs`
//     does, so any UI component pulled in by a test can load under
//     plain Node without a Vite asset pipeline.
//
//  2. Patch every dashboard module that touches `import.meta.env` so
//     the reference is rewritten to `globalThis.__HAWK_TEST_VITE_ENV`.
//     Tests seed that global before any dashboard module imports,
//     which lets the LAN/internal helpers resolve real URLs via
//     `VITE_INTERNAL_API_URL`, switch behaviour on
//     `VITE_LAN_SESSION_LOGIN`, and assert the
//     `VITE_EXPECTED_INSTALL_PROFILE` mismatch banner.
//
// This loader is TEST-ONLY — never used by Vite or production builds.

const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|ico|avif)(\?.*)?$/i;
const CSS_RE = /\.css(\?.*)?$/i;

const PATCH_PATHS = [
  "/lib/internal-migration.ts",
  "/lib/unit-join.ts",
  "/lib/install-profile.tsx",
  "/lib/api-client.ts",
  "/pages/Login.tsx",
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
    src = src.split("import.meta.env").join("globalThis.__HAWK_TEST_VITE_ENV");
    return { ...result, source: src };
  }
  return nextLoad(url, context);
}

export async function resolve(specifier, context, nextResolve) {
  return nextResolve(specifier, context);
}
