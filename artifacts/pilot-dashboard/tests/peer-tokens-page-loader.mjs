// Combined ESM loader hook for the peer-tokens page e2e test.
//
// Two responsibilities, kept in one file so a single `--import` registers
// everything the test needs:
//
//  1. Stub static-asset and CSS imports the same way `asset-loader.mjs`
//     does, so any UI component pulled in by `PeerTokens.tsx` can load
//     under plain Node without a Vite asset pipeline.
//
//  2. Patch `internal-migration.ts` so its module-scope reference to
//     `import.meta.env` is rewritten to `globalThis.__HAWK_TEST_VITE_ENV`.
//     The test sets that global before any dashboard module imports,
//     which lets the helpers (fetchInternalPeerTokens / postInternal…
//     PeerTokenCreate / deleteInternalPeerToken) resolve a real URL via
//     `VITE_INTERNAL_API_URL` and hit our mocked `globalThis.fetch`.
//
// This loader is TEST-ONLY — never used by Vite or production builds.

const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|ico|avif)(\?.*)?$/i;
const CSS_RE = /\.css(\?.*)?$/i;

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
  if (url.endsWith("/lib/internal-migration.ts")) {
    const result = await nextLoad(url, context);
    let src = result.source == null ? "" : String(result.source);
    // tsx/esbuild keeps `import.meta.env` references as-is during TS->JS
    // transpilation. A plain string substitution turns the gating expr
    //   typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {}
    // into
    //   typeof import.meta !== "undefined" && globalThis.__HAWK_TEST_VITE_ENV ? globalThis.__HAWK_TEST_VITE_ENV : {}
    // and lets the test inject VITE_INTERNAL_API_URL / VITE_LAN_SESSION_LOGIN
    // before the module's first read.
    src = src.split("import.meta.env").join("globalThis.__HAWK_TEST_VITE_ENV");
    return { ...result, source: src };
  }
  return nextLoad(url, context);
}

export async function resolve(specifier, context, nextResolve) {
  return nextResolve(specifier, context);
}
