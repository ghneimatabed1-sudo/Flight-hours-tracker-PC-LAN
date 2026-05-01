// Registers the test-only loader hook used by `about-this-pc.test.ts`.
// Kept separate from the loader file so the loader stays a plain hook
// module (no global side effects on import).
import { register } from "node:module";

register("./about-this-pc-loader.mjs", import.meta.url);
