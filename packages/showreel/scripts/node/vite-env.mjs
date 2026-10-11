// Node has no Vite: the web data layer reads `import.meta.env` (BASE_URL) when its module loads.
// This load hook gives those web modules the values a production build would see, so
// scripts/props.ts can reuse the web's own record builders read-only. Runs after tsx compiles.
import { register } from "node:module";

register("./vite-env-hook.mjs", import.meta.url);
