// ESM loader hook for the AboutThisPc component test.
//
// Same shape as `peer-tokens-page-loader.mjs`:
//
//   1. Stub static-asset and CSS imports so any UI module pulled in by
//      `AboutThisPc.tsx` (or its Layout dependency) can load under
//      plain Node without a Vite asset pipeline.
//
//   2. Patch `internal-migration.ts` so its module-scope reference to
//      `import.meta.env` resolves to `globalThis.__HAWK_TEST_VITE_ENV`.
//      The test sets that global before any dashboard module imports,
//      which lets `fetchInternalAboutThisPc` resolve a real URL via
//      `VITE_INTERNAL_API_URL` and hit our mocked `globalThis.fetch`.
//
// Test-only — never used by Vite, the mobile app or production builds.

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
    src = src.split("import.meta.env").join("globalThis.__HAWK_TEST_VITE_ENV");
    return { ...result, source: src };
  }
  return nextLoad(url, context);
}

export async function resolve(specifier, context, nextResolve) {
  return nextResolve(specifier, context);
}
