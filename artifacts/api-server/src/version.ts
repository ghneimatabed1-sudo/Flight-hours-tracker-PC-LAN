// Build-time injected by esbuild's `define` (see `build.mjs`). At
// typecheck time the `declare const` tells TypeScript the symbol
// exists; at bundle time esbuild substitutes the literal string
// before the bundle is written.
declare const __API_SERVER_VERSION__: string;

export const API_SERVER_VERSION: string =
  typeof __API_SERVER_VERSION__ === "string" && __API_SERVER_VERSION__
    ? __API_SERVER_VERSION__
    : "0.0.0";
