// Tiny shim that registers the test-only asset/CSS loader hook on the
// running node process. Used by `pnpm test` via `tsx --import`. Kept
// separate from the loader file so the loader itself can be a plain
// hook module (no global side effects on import).
import { register } from "node:module";

register("./asset-loader.mjs", import.meta.url);
