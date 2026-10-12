// Lets the seed integrity test load the playground seed in plain Node: resolves
// the app's `@/` alias to the project root and Next-style extensionless /
// directory imports. Run from the app root:
//   node --import ./lib/playground/__tests__/register.mjs --test lib/playground/__tests__/seed.test.mjs
import { register } from "node:module";

register(new URL("./resolve_hooks.mjs", import.meta.url));
