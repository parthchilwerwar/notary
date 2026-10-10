/**
 * Vitest setup (vitest.config.ts): every test file starts with the process-wide rate-limit scope
 * on a VirtualClock. Tests stub fetch or install a transport, so their "live" Crustdata requests
 * never reach the network; without this, a file that records more than 15 of them would sleep a
 * real minute in the shared limiter. The throttle logic itself is tested in throttle.test.ts.
 */
import { LlmLimiter, setLlmLimiter } from "../src/llm/limiter.js";
import { RateLimitScope, VirtualClock, setRateLimitScope } from "../src/tools/index.js";

setRateLimitScope(new RateLimitScope({ clock: new VirtualClock() }));
// Same for the process-wide model-call limiter (src/llm/limiter.ts): tests never reach a provider,
// and a "real" client in a test must never sleep in real time. The limiter logic is tested in llm-ratelimit.test.ts.
setLlmLimiter(new LlmLimiter({ clock: new VirtualClock(), env: {} }));
