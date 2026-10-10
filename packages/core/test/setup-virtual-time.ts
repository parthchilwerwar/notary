/**
 * Vitest setup (vitest.config.ts): every test file starts with the process-wide rate-limit scope
 * on a VirtualClock. Tests stub fetch or install a transport, so their "live" Crustdata requests
 * never reach the network; without this, a file that records more than 15 of them would sleep a
 * real minute in the shared limiter. The throttle logic itself is tested in throttle.test.ts.
 */
import { RateLimitScope, VirtualClock, setRateLimitScope } from "../src/tools/index.js";

setRateLimitScope(new RateLimitScope({ clock: new VirtualClock() }));
