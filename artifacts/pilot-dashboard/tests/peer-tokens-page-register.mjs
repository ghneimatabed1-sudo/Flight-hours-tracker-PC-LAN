// Registers the test-only loader hook used by `peer-tokens-page.test.ts`.
// Kept separate from the loader file so the loader stays a plain hook
// module (no global side effects on import).
import { register } from "node:module";

register("./peer-tokens-page-loader.mjs", import.meta.url);
