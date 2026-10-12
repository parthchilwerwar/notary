// Container entry point for the hosted, read-only Notary API (Dockerfile CMD). Not a CLI command:
// `notary serve` stays loopback + session token; this binds 0.0.0.0 behind the AWS load balancer and
// uses the hosted bearer token (src/api/hosted.ts). Configuration comes only from the environment
// (ECS task definition + Secrets Manager); nothing is read from a .env file and no value is printed.
import { createHostedApp, hostedConfig } from "./api/hosted.js";
import { cachedGuardCoverage } from "./api/server.js";
import { flushTracing, initTracing, shutdownTracing } from "./trace/index.js";

const cfg = hostedConfig();
if (!cfg.ok) {
  console.error(cfg.blocked);
  process.exit(3);
}

await initTracing({ serviceName: "hosted" });
const { serve } = await import("@hono/node-server");
// Start the slow guard-coverage walk (child process) now, so chat's first get_guard_coverage finds it ready.
const guardCoverage = cachedGuardCoverage();
void guardCoverage().catch(() => undefined);
const app = createHostedApp(cfg, { guardCoverage });
const server = serve({ fetch: app.fetch, port: cfg.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`notary hosted: listening on 0.0.0.0:${info.port} (read-only; ask/chat need the hosted bearer token; ${cfg.origins.length} CORS origin(s))`);
});

let stopping = false;
const stop = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  console.log(`notary hosted: ${signal}, draining`);
  server.close(() => {
    void Promise.race([flushTracing().then(() => shutdownTracing()), new Promise((r) => setTimeout(r, 5000))]).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 25_000).unref();
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
