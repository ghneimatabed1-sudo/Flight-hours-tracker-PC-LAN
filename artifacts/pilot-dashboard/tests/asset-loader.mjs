// Node ESM loader hook used by the sidebar-smoke test runner.
//
// Vite handles `import logo from "@/assets/foo.png"` and `import
// "react-day-picker/src/style.css"` by emitting build-time stubs (the
// PNG resolves to a hashed URL string; the CSS gets bundled). Plain
// node has no such transform, so importing those files from a page
// module under `tsx --test` blows up with `ERR_UNKNOWN_FILE_EXTENSION`.
//
// We stub them here:
//   - .png / .jpg / .jpeg / .gif / .svg / .webp  → string URL stand-in
//   - .css  → empty side-effect module
//
// This loader is a TEST-ONLY shim — it is never used by Vite, the
// dashboard build, the mobile app, or production code.

const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|ico|avif)(\?.*)?$/i;
const CSS_RE   = /\.css(\?.*)?$/i;

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
  return nextLoad(url, context);
}

export async function resolve(specifier, context, nextResolve) {
  // Let node resolve the URL first; we only need to override the load step.
  return nextResolve(specifier, context);
}
