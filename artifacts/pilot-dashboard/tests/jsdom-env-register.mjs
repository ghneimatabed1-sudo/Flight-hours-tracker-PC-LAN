// Registers the test-only loader hook used by the jsdom component
// tests added in Task #406 (T-L). Kept separate from the loader file
// so the loader stays a plain hook module with no global side effects.
import { register } from "node:module";

register("./jsdom-env-loader.mjs", import.meta.url);
