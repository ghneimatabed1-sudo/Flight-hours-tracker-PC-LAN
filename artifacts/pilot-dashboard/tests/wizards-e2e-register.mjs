// Registers the test-only loader hook used by `wizards-e2e.test.ts`.
// Kept separate from the loader file so the loader stays a plain hook
// module (no global side effects on import).
import { register } from "node:module";

register("./wizards-e2e-loader.mjs", import.meta.url);
