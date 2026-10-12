/**
 * OAuth for cfo.ai's MCP server, through the MCP TypeScript SDK's client auth (authorization code +
 * PKCE S256, RFC 9728 protected-resource discovery, RFC 8414 metadata, RFC 7591 dynamic client
 * registration). Checked 2026-10-12 against https://api.cfo.ai/mcp: 401 with
 * `resource_metadata=https://api.cfo.ai/.well-known/oauth-protected-resource/mcp`, authorization
 * server https://complete-cottage-73.authkit.app (WorkOS AuthKit) with a registration endpoint,
 * S256, public clients (token_endpoint_auth_method "none") and refresh tokens.
 *
 * Notary registers itself as a public native client with a loopback redirect
 * (http://127.0.0.1:<random port>/callback, RFC 8252) and opens the user's browser on cfo.ai's
 * authorize page. The user signs in there; Notary never sees a password. Tokens go to the
 * gitignored cfo-oauth.json (src/cfo/store.ts) and are never printed.
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { readOAuth, writeOAuth, type CfoPaths } from "./store.js";

export const CFO_CLIENT_NAME = "Notary CLI";
/** Scopes cfo.ai's authorization server advertises; offline_access is what yields a refresh token. */
export const CFO_SCOPE = "openid profile email offline_access";
export const CALLBACK_PATH = "/callback";

export class CfoNotConnectedError extends Error {
  constructor(message = "cfo.ai is not connected (or the sign-in expired and could not be refreshed). Run: pnpm notary cfo connect") {
    super(message);
    this.name = "CfoNotConnectedError";
  }
}

export interface ProviderOptions {
  paths: CfoPaths;
  server: string;
  /** Interactive (connect): the loopback redirect URL and how to show the authorize URL. */
  interactive?: { redirectUrl: string; state: string; onAuthorize: (url: URL) => void | Promise<void> };
  now?: () => Date;
}

/** OAuthClientProvider backed by cfo-oauth.json. Non-interactive (status, sync, serve) never opens a browser. */
export class CfoOAuthProvider implements OAuthClientProvider {
  private verifier: string | null = null;
  constructor(private readonly opts: ProviderOptions) {}

  private file() {
    return readOAuth(this.opts.paths, this.opts.server);
  }

  get redirectUrl(): string {
    if (this.opts.interactive) return this.opts.interactive.redirectUrl;
    // Must be defined (an undefined redirect URL makes the SDK attempt a client_credentials grant).
    return this.file().client?.redirect_uris?.[0] ?? `http://127.0.0.1${CALLBACK_PATH}`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: CFO_CLIENT_NAME,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: CFO_SCOPE,
    };
  }

  state(): string {
    if (!this.opts.interactive) throw new CfoNotConnectedError();
    return this.opts.interactive.state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const client = this.file().client;
    if (!client) return undefined;
    // A new loopback port means a new redirect URI: register again rather than send a redirect
    // the registration does not list.
    if (this.opts.interactive && !(client.redirect_uris ?? []).includes(this.opts.interactive.redirectUrl)) return undefined;
    return client as OAuthClientInformationMixed;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    const f = this.file();
    writeOAuth(this.opts.paths, { ...f, client: { ...(info as Record<string, unknown>), client_id: info.client_id, redirect_uris: "redirect_uris" in info ? info.redirect_uris : [this.redirectUrl] } });
  }

  tokens(): OAuthTokens | undefined {
    return (this.file().tokens as OAuthTokens | null) ?? undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    const f = this.file();
    writeOAuth(this.opts.paths, { ...f, tokens: { ...tokens }, tokensSavedAt: (this.opts.now ?? (() => new Date()))().toISOString() });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.opts.interactive) throw new CfoNotConnectedError();
    await this.opts.interactive.onAuthorize(url);
  }

  saveCodeVerifier(v: string): void {
    this.verifier = v;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("no PKCE code verifier for this sign-in (start again: pnpm notary cfo connect)");
    return this.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    const f = this.file();
    writeOAuth(this.opts.paths, { ...f, discovery: state });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return (this.file().discovery as OAuthDiscoveryState | undefined) ?? undefined;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const f = this.file();
    if (scope === "verifier") {
      this.verifier = null;
      return;
    }
    writeOAuth(this.opts.paths, {
      server: f.server,
      client: scope === "all" || scope === "client" ? null : f.client,
      tokens: scope === "all" || scope === "tokens" ? null : f.tokens,
      tokensSavedAt: scope === "all" || scope === "tokens" ? null : f.tokensSavedAt,
      ...(scope === "all" || scope === "discovery" || f.discovery === undefined ? {} : { discovery: f.discovery }),
    });
  }
}

export const newState = (): string => randomBytes(24).toString("base64url");

export interface CallbackServer {
  /** http://127.0.0.1:<port>/callback */
  redirectUrl: string;
  /** Resolves with the authorization code once the browser comes back with the right state. */
  code: Promise<string>;
  close(): Promise<void>;
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;margin:3rem;max-width:36rem"><h1 style="font-size:1.4rem">${title}</h1><p>${body}</p></body>`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * One-shot loopback listener for the OAuth redirect: 127.0.0.1 only, random port, the state must
 * match, gives up after `timeoutMs`. The code is never printed.
 */
export async function startCallbackServer(opts: { state: string; timeoutMs?: number; host?: string }): Promise<CallbackServer> {
  const host = opts.host ?? "127.0.0.1";
  let resolve!: (code: string) => void;
  let reject!: (err: Error) => void;
  const code = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  code.catch(() => undefined);
  let settled = false;
  const finish = (err: Error | null, value?: string) => {
    if (settled) return;
    settled = true;
    if (err) reject(err);
    else resolve(value!);
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      const description = url.searchParams.get("error_description") ?? "";
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(page("cfo.ai sign-in failed", esc(`${error}${description ? `: ${description}` : ""}`)));
      finish(new Error(`cfo.ai authorization failed: ${error}${description ? ` (${description.slice(0, 200)})` : ""}`));
      return;
    }
    if (url.searchParams.get("state") !== opts.state) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(page("Sign-in not accepted", "The state parameter does not match this sign-in. Start again with pnpm notary cfo connect."));
      finish(new Error("OAuth state mismatch: the redirect did not come from this sign-in"));
      return;
    }
    const value = url.searchParams.get("code");
    if (!value) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(page("Sign-in not accepted", "No authorization code in the redirect."));
      finish(new Error("the redirect carried no authorization code"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("Notary is connected to cfo.ai", "You can close this tab and go back to the terminal."));
    finish(null, value);
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, host, () => res());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the loopback callback server has no port");
  const timer = setTimeout(() => finish(new Error(`no sign-in within ${Math.round((opts.timeoutMs ?? 300_000) / 1000)} s; run pnpm notary cfo connect again`)), opts.timeoutMs ?? 300_000);
  timer.unref();
  return {
    redirectUrl: `http://${host}:${address.port}${CALLBACK_PATH}`,
    code,
    close: () =>
      new Promise<void>((done) => {
        clearTimeout(timer);
        finish(new Error("sign-in cancelled"));
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}
