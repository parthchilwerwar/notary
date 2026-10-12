// The Notary guide (/docs): one typed list of sections. The sidebar, the phone "Contents"
// disclosure and the page body are all generated from SECTIONS, so a section can't exist in one
// place and not the other. Every command, flag and variable here is taken from
// packages/core/src/cli.ts and .env.example; test/docs-page.test.ts checks them against those files.
import type { ReactNode } from "react";
import { Link } from "react-router";
import { C, CodeBlock, Note, RefTable } from "./parts";

export const REPO_URL = "https://github.com/parthchilwerwar/notary";

/** The exact install commands (README.md's "Install the CLI" uses the same lines). */
export const INSTALL_COMMANDS = `git clone https://github.com/parthchilwerwar/notary.git
cd notary
pnpm install
pnpm notary --help`;

export const GROUPS = ["Get started", "Use Notary", "Trust and safety", "Help"] as const;
export type Group = (typeof GROUPS)[number];

export type DocSection = {
  /** Anchor id (also the sidebar link target). */
  id: string;
  title: string;
  group: Group;
  body: ReactNode;
};

export type QuickLink = { href: string; title: string; text: string };

export const QUICK_LINKS: QuickLink[] = [
  { href: "#quick-start", title: "Your first run", text: "Install to first certificate" },
  { href: "#how-it-works", title: "How it works", text: "Read, test, challenge, certify, enforce" },
  { href: "#troubleshooting", title: "Need a hand?", text: "Troubleshooting" },
];

// ---------------------------------------------------------------- commands

export type CommandDoc = {
  /** As typed after `pnpm notary` (subcommands separated by a space). */
  name: string;
  summary: string;
  /** Key flags, each starting with its `--name` exactly as cli.ts declares it. */
  flags: string[];
  needs: string;
};

export const COMMANDS: CommandDoc[] = [
  {
    name: "notarize",
    summary: "Run the notarization loop for one tool: recon, deterministic checker, rival hypotheses, probes, beliefs, evidence check, adversary.",
    flags: ["--tool <crustdata|dodo> (required)", "--priors-from <crustdata|dodo>", "--priors-bundle <path>", "--recon-only", "--replay", "--adversary <bedrock|session> (default bedrock)", "--compare-priors"],
    needs: "Live: the tool's key plus model settings. --replay and --compare-priors read cassettes and need no tool keys.",
  },
  {
    name: "run",
    summary: "Work the billing queue and write a run bundle. Guarded by default; --naive is the ungated baseline.",
    flags: ["--queue <file>", "--naive", "--resume", "--run <runId> (with --resume)", "--replay <cassette>"],
    needs: "Live: CRUSTDATA_API_KEY, DODO_PAYMENTS_API_KEY (test) and a seed manifest. --replay needs none.",
  },
  {
    name: "replay",
    summary: "Re-run recorded live bundles from their cassettes and compare every metric and record exactly.",
    flags: ["--bundle <id>", "--drift <fixture>"],
    needs: "No keys. Never reads .env.",
  },
  {
    name: "eval noise-floor",
    summary: "Run the guarded queue N times and record each metric's run-to-run spread as its noise floor.",
    flags: ["--queue <file> (required)", "--runs <n> (default 3)", "--replay"],
    needs: "Same as run. --replay uses the newest recorded run and needs no keys.",
  },
  {
    name: "export",
    summary: "Write export/TOOLS.md, export/guards.json and docs/EVALUATION.md from real bundles, and copy the newest bundles to the dashboard.",
    flags: ["--certificates", "--fixture (with --certificates)", "--content", "--evidence", "--explain", "--sample", "--seed <n> (with --sample)", "--out <dir>", "--runs-dir <dir>", "--root <dir>", "--no-checks"],
    needs: "No keys.",
  },
  {
    name: "serve",
    summary: "Local API and SSE stream for the dashboard's live mode. Prints a per-session token once.",
    flags: ["--port <port> (default 8787)", "--host <host> (default 127.0.0.1)"],
    needs: "None to start. Chat answers need model settings; approving a held action needs DODO_PAYMENTS_API_KEY.",
  },
  {
    name: "guards coverage",
    summary: "Check that every raw client method is reachable only through a guard. Non-zero exit on any unguarded call site.",
    flags: ["--json", "--backend <auto|entire|tsc> (default auto)"],
    needs: "No keys.",
  },
  {
    name: "demo",
    summary: "Keyless walkthrough on recorded fixtures: the whole pipeline on a simulated API with model doubles, clearly labelled as fixture data.",
    flags: ["--fixture (required)", "--publish", "--scenario <default|change-api>"],
    needs: "No keys, no network. Never reads .env.",
  },
  {
    name: "trace-link",
    summary: "Derive the neatlogs trace URL template from one real trace URL and write packages/core/config/neatlogs.json.",
    flags: ["--example <url> (required)", "--trace-id <id> (required)"],
    needs: "A trace URL copied from the neatlogs UI.",
  },
  {
    name: "doctor",
    summary: "Emit one neatlogs test span and flush. With --llm, check the model provider, the three role models and one tiny call per role.",
    flags: ["--llm"],
    needs: "NEATLOGS_API_KEY (or model settings with --llm).",
  },
  {
    name: "economics",
    summary: "Write the Business tab data, docs/BUSINESS.md and export/cfo-inputs.csv: unit economics from real bundles plus the imported cfo.ai plan.",
    flags: ["--cfo-import <file>", "--runs-dir <dir>", "--out <file>"],
    needs: "No keys.",
  },
  {
    name: "cfo connect",
    summary: "Sign in to cfo.ai in your own browser (OAuth with PKCE, loopback redirect) and choose the workspace Notary reads. cfo.ai has no API key; its MCP server is the way in.",
    flags: ["--org <id>", "--discover-only"],
    needs: "A cfo.ai account. Tokens stay in the gitignored packages/core/config/cfo-oauth.json and are never printed.",
  },
  {
    name: "cfo status",
    summary: "Whether cfo.ai is connected, which workspace, when the access token expires and how the last sync went. Never shows a token.",
    flags: ["--json"],
    needs: "No keys.",
  },
  {
    name: "cfo sync",
    summary: "Read the plan from cfo.ai over MCP (inspect_table_blocks), map it strictly (rows without a unit or with non-numeric cells are rejected), then regenerate the Business tab data and docs/BUSINESS.md like economics.",
    flags: ["--table <name> (repeatable, default Notary Plan)", "--scenario <name> (default Main)"],
    needs: "A cfo.ai connection (cfo connect).",
  },
  {
    name: "cfo push",
    summary: "Explains why Notary's per-run costs are not written into cfo.ai over MCP (no documented data-row write) and points at the CSV upload. Exits 3.",
    flags: [],
    needs: "No keys.",
  },
];

/** `--name` of a flag string ("--tool <crustdata|dodo> (required)" -> "--tool"). */
export const flagName = (flag: string) => flag.split(/[\s(]/, 1)[0]!;

/** Prose with `--flag` names set as inline code (so a flag never breaks across lines). */
function withFlags(text: string): ReactNode {
  return text.split(/(--[a-z][a-z-]*)/g).map((part, i) => (i % 2 === 1 ? <C key={i}>{part}</C> : part));
}

/** "--runs <n> (default 3)" -> ["--runs <n>", "default 3"]. */
export function splitFlag(flag: string): [string, string | undefined] {
  const m = /^(.*?)\s+\((.+)\)$/.exec(flag);
  return m ? [m[1]!, m[2]!] : [flag, undefined];
}

// ---------------------------------------------------------------- environment

export type EnvVar = { name: string; purpose: string; value?: string };
export type EnvGroup = { title: string; vars: EnvVar[] };

export const ENV_GROUPS: EnvGroup[] = [
  {
    title: "Safety",
    vars: [{ name: "NOTARY_MODE", value: "test", purpose: "The Dodo client refuses to start unless this is test." }],
  },
  {
    title: "Crustdata (company enrichment)",
    vars: [
      { name: "CRUSTDATA_API_KEY", purpose: "Crustdata API key, for company enrichment and the Crustdata notarization." },
      { name: "CRUSTDATA_CREDIT_BUDGET", value: "200", purpose: "Hard per-run credit cap. A call that would cross it is never sent; the run stops cleanly." },
      { name: "NOTARY_CRUSTDATA_RPM", purpose: "Requests per rolling minute. Can only lower the documented 15." },
    ],
  },
  {
    title: "Dodo Payments (test mode only)",
    vars: [
      { name: "DODO_PAYMENTS_API_KEY", purpose: "A Dodo test-mode key. Used for refunds, plan changes, wallet credits and seeding." },
      { name: "DODO_BASE_URL", value: "https://test.dodopayments.com", purpose: "Must be exactly the test URL; the client refuses any other." },
    ],
  },
  {
    title: "neatlogs (tracing)",
    vars: [
      { name: "NEATLOGS_API_KEY", purpose: "Project ingest key. Without it spans still go to the local runs/<runId>/spans.jsonl." },
      { name: "NEATLOGS_SERVICE_TOKEN", purpose: "Service-account token for reading traces back with neatlogs-cli." },
    ],
  },
  {
    title: "Models",
    vars: [
      { name: "NOTARY_LLM_PROVIDER", purpose: "litellm or bedrock. Unset means bedrock." },
      { name: "NOTARY_MODEL_EXECUTOR", purpose: "Model id for the executor role (Bedrock model id, or a LiteLLM model name). Chat answers use it." },
      { name: "NOTARY_MODEL_REFLECTOR", purpose: "Model that proposes rival hypotheses for each anomaly." },
      { name: "NOTARY_MODEL_ADVERSARY", purpose: "Model that tries to refute candidate beliefs. Must differ from the reflector." },
      { name: "NOTARY_LLM_RPM", purpose: "Model request starts per rolling minute (default 30)." },
      { name: "NOTARY_LLM_CONCURRENCY", purpose: "Model calls in flight at once (default 2)." },
    ],
  },
  {
    title: "AWS Bedrock (provider bedrock or unset)",
    vars: [
      { name: "AWS_REGION", value: "us-east-1", purpose: "Region for the Bedrock Converse API." },
      { name: "AWS_ACCESS_KEY_ID", purpose: "AWS credentials (the default credential chain also works)." },
      { name: "AWS_SECRET_ACCESS_KEY", purpose: "AWS credentials (the default credential chain also works)." },
    ],
  },
  {
    title: "LiteLLM proxy (provider litellm)",
    vars: [
      { name: "LITELLM_BASE_URL", purpose: "OpenAI-compatible proxy URL, with or without a trailing /v1." },
      { name: "LITELLM_API_KEY", purpose: "Proxy key, sent as a Bearer token." },
    ],
  },
  {
    title: "Probing and tuning (optional)",
    vars: [
      { name: "NOTARY_MAX_PROBES_PER_CLAIM", value: "5", purpose: "Most probes per claim per notarize run before the belief abstains." },
      { name: "NOTARY_PROBE_LAMBDA", purpose: "Probe score weight: credits + lambda × calls (default 1)." },
      { name: "NOTARY_PRIOR_STRENGTH", purpose: "Transfer-prior pseudo-counts (default 2)." },
      { name: "NOTARY_MAX_USD", purpose: "Hard per-run cap on model spend in USD. Empty means no cap." },
      { name: "NOTARY_PRICE_REFLECTOR_IN", purpose: "USD per 1M tokens per role, IN and OUT (also _EXECUTOR_ and _ADVERSARY_). Unknown prices are recorded as $0 with a warning." },
    ],
  },
  {
    title: "Dashboard",
    vars: [{ name: "VITE_NOTARY_API", purpose: "Where the dashboard looks for notary serve. Default http://localhost:8787." }],
  },
];

// ---------------------------------------------------------------- sections

const pipeline: { step: string; text: ReactNode }[] = [
  {
    step: "Read",
    text: (
      <>
        Every concrete promise in the Crustdata and Dodo docs becomes a machine-checkable claim, quoted and linked. A recon sweep records cheap
        calls, and a deterministic checker compares each response with each claim. Same exchanges in, same anomalies out.
      </>
    ),
  },
  {
    step: "Test",
    text: (
      <>
        The reflector model proposes two or three rival explanations per anomaly. Probes are chosen by a cost-aware score, and each prediction is
        hashed into SQLite <em>before</em> the HTTP call. Fixed verdict rules feed a Beta belief per claim.
      </>
    ),
  },
  {
    step: "Challenge",
    text: (
      <>
        A different model (or a headless Claude Code session) reads only the raw probe records and tries to refute each candidate belief: uphold,
        narrow its scope, or downgrade it. Every cited probe must also pass an evidence check against its recorded span.
      </>
    ),
  },
  {
    step: "Certify",
    text: (
      <>
        Each surviving belief becomes a certificate: the claim, the doc text, a verdict, its scope, the evidence and a sha256. Unproven claims get a
        "no certificate" entry with the reason.
      </>
    ),
  },
  {
    step: "Enforce",
    text: (
      <>
        Certificates that contradict the docs compile into guards that wrap every Dodo and Crustdata call. A money action runs only if every
        certificate it depends on is active. Otherwise it is held for a person, with the evidence attached.
      </>
    ),
  },
];

const dashboardPages: { name: string; path: string; text: ReactNode }[] = [
  {
    name: "Run",
    path: "/app/run",
    text: "One run, step by step: each queue item, the policy decision, the guards that fired, the effects it had and why it was executed, held or escalated.",
  },
  {
    name: "Certificates",
    path: "/app/certificates",
    text: "Every claim per tool with its certificate (matches docs or contradicts docs), its scope and evidence, or the reason there is none. Revoked certificates stay listed, struck through.",
  },
  {
    name: "Approvals",
    path: "/app/approvals",
    text: "Held money actions waiting for a person. In live mode you approve or reject them here; the hosted site shows them read-only.",
  },
  {
    name: "Chat",
    path: "/app/chat",
    text: "Ask about runs, certificates and the APIs Notary checks. Every answer cites records. Without a server, a deterministic replay engine answers from the published files and no model runs.",
  },
  {
    name: "Report",
    path: "/app/report",
    text: "The naive and guarded runs side by side within one world, cost per run, connections to the integrations, and receipts (traces, checkpoints, tool evidence).",
  },
];

const troubles: { symptom: ReactNode; fix: ReactNode }[] = [
  {
    symptom: (
      <>
        <C>BLOCKED: &lt;VAR&gt; not set</C> and exit code 3
      </>
    ),
    fix: (
      <>
        A keyed command is missing a variable. Nothing was sent: every command checks before its first network call. Add the named variable to{" "}
        <C>.env</C> and run it again.
      </>
    ),
  },
  {
    symptom: (
      <>
        <C>notary replay</C> exits 3
      </>
    ),
    fix: <>There is no recorded live run to replay yet. Replay never reports a pass when nothing was recorded. Record runs with keys first.</>,
  },
  {
    symptom: (
      <>
        <C>notary replay</C> exits 1
      </>
    ),
    fix: <>A cassette miss, a tampered file, a pin mismatch or a metric that differs. The output names which one.</>,
  },
  {
    symptom: <>The dashboard shows a hash mismatch</>,
    fix: (
      <>
        A bundle's content no longer matches its <C>contentHash</C>, so the dashboard withholds it. Bundles are never edited by hand: regenerate
        them with <C>pnpm notary export</C> (or the command that wrote them).
      </>
    ),
  },
  {
    symptom: <>The Dodo client refuses to start</>,
    fix: (
      <>
        The test-mode lock: <C>NOTARY_MODE</C> must be <C>test</C> and <C>DODO_BASE_URL</C> exactly <C>https://test.dodopayments.com</C>.
      </>
    ),
  },
  {
    symptom: <>Reflector and adversary rejected</>,
    fix: (
      <>
        <C>NOTARY_MODEL_REFLECTOR</C> and <C>NOTARY_MODEL_ADVERSARY</C> must be different models. Check the whole model setup with{" "}
        <C>pnpm notary doctor --llm</C> (exit 0 ok, 1 a real failure, 3 BLOCKED).
      </>
    ),
  },
  {
    symptom: <>"Paste the session token" or a rejected token</>,
    fix: (
      <>
        Copy the token from the terminal running <C>notary serve</C>. Each start makes a new one, so after a restart paste it again.
      </>
    ),
  },
  {
    symptom: <>The dashboard stays in replay mode</>,
    fix: (
      <>
        It switches to live only when <C>GET /api/health</C> answers at <C>VITE_NOTARY_API</C> (default <C>http://localhost:8787</C>) and the page
        itself is served from localhost. The hosted build never probes.
      </>
    ),
  },
  {
    symptom: (
      <>
        <C>ExperimentalWarning: SQLite is an experimental feature</C>
      </>
    ),
    fix: <>Node 24 prints this the first time the store opens. It is harmless.</>,
  },
  {
    symptom: <>Model cost shows $0 with a warning</>,
    fix: (
      <>
        The model id isn't in the built-in price table. Set <C>NOTARY_PRICE_&lt;ROLE&gt;_IN</C> and <C>_OUT</C> for that role.
      </>
    ),
  },
  {
    symptom: (
      <>
        A run ends with status <C>stopped_budget</C>
      </>
    ),
    fix: (
      <>
        It hit <C>CRUSTDATA_CREDIT_BUDGET</C> or <C>NOTARY_MAX_USD</C>. Raise the cap if that was intended.
      </>
    ),
  },
];

export const SECTIONS: DocSection[] = [
  {
    id: "quick-start",
    title: "Quick start",
    group: "Get started",
    body: (
      <>
        <p>
          You can see the whole pipeline without any API keys. Clone the repo, install the workspace, and run the keyless walkthrough on recorded
          fixtures. It drives the real code paths against an in-process simulated API with deterministic model doubles, and labels everything it
          prints as fixture data.
        </p>
        <CodeBlock code={`${INSTALL_COMMANDS}\npnpm notary demo --fixture`} />
        <p>
          The walkthrough prints one block per stage, from recon to the drift replay, and ends with{" "}
          <C>demo finished: every stage ran on fixtures; nothing above is a live result</C>. Each stage also says what a live run would need.
          Its bundles go to <C>packages/core/runs/demo/</C>, which git ignores.
        </p>
        <p>To see the certificates and runs in the dashboard, start the web app and open the printed address:</p>
        <CodeBlock code={`pnpm --filter @notary/web dev\n# then open http://127.0.0.1:5173/app/certificates?fixtures=1`} />
        <p>
          The dashboard lists only real runs. The fixture bundles and certificates in <C>packages/web/public/</C> appear only when you add{" "}
          <C>?fixtures=1</C> to the address, under a "Fixture data — simulated APIs, not a live run" banner. <C>pnpm notary demo --fixture --publish</C> refreshes the fixture bundles and{" "}
          <C>pnpm notary export --certificates --fixture</C> rebuilds their certificates.
        </p>
        <Note title="Real runs need keys">
          Live notarization and queue runs call Crustdata, Dodo Payments (test mode) and your model provider. See{" "}
          <a href="#configure-credentials">Configure credentials</a>. No live run has been recorded in this repo yet.
        </Note>
      </>
    ),
  },
  {
    id: "install",
    title: "Install the CLI",
    group: "Get started",
    body: (
      <>
        <p>Notary is a pnpm workspace. The CLI is the TypeScript package in packages/core, run through tsx, so there is no build step.</p>
        <ul>
          <li>
            <strong>Node 22 or newer.</strong> It was built on Node 24.
          </li>
          <li>
            <strong>pnpm 11.7.0</strong>, the version pinned in the root <C>package.json</C> (<C>packageManager</C>). For example{" "}
            <C>npm install -g pnpm@11.7.0</C>.
          </li>
          <li>
            <strong>git</strong>, to clone the repository.
          </li>
        </ul>
        <CodeBlock code={INSTALL_COMMANDS} />
        <p>
          Every command runs from the repo root as <C>pnpm notary &lt;command&gt;</C>, and <C>pnpm notary &lt;command&gt; --help</C> lists its
          flags. Once your <C>.env</C> holds a neatlogs key, check tracing end to end:
        </p>
        <CodeBlock code={`pnpm notary doctor\npnpm notary doctor --llm`} />
        <p>
          <C>doctor</C> sends one neatlogs test span. <C>doctor --llm</C> checks the model provider, the executor, reflector and adversary models
          and their separation, with one tiny call per role.
        </p>
        <p>Checks that need no keys:</p>
        <CodeBlock code={`pnpm test\npnpm typecheck\npnpm notary guards coverage\npnpm notary demo --fixture`} />
      </>
    ),
  },
  {
    id: "configure-credentials",
    title: "Configure credentials",
    group: "Get started",
    body: (
      <>
        <p>
          Copy <C>.env.example</C> to <C>.env</C> at the repo root and fill in what each step needs. <C>.env</C> is gitignored. Commands read it
          into the process environment and never print it; <C>replay</C> and <C>demo</C> never read it at all.
        </p>
        <CodeBlock code="cp .env.example .env" />
        <Note title="Dodo Payments runs in test mode only" tone="warn">
          The Dodo client refuses to start unless <C>NOTARY_MODE=test</C> and the base URL is exactly <C>https://test.dodopayments.com</C>. Use a
          test-mode key. Secrets are never logged, traced or written to cassettes.
        </Note>
        {ENV_GROUPS.map((g) => (
          <div key={g.title} className="docs-env-group">
            <h3>{g.title}</h3>
            <RefTable
              caption={`${g.title} variables`}
              rowKey={(v) => v.name}
              rows={g.vars}
              columns={[
                { header: "Variable", className: "docs-col-name", cell: (v) => <C>{v.name}</C> },
                { header: "Default", className: "docs-col-default", cell: (v) => (v.value ? <C>{v.value}</C> : <span className="docs-muted">empty</span>) },
                { header: "What it's for", cell: (v) => v.purpose },
              ]}
            />
          </div>
        ))}
        <p>
          Recording the live sequence (seed the Dodo test world, notarize Crustdata, notarize Dodo with priors, run the queue naive then guarded,
          replay, export) is listed step by step, with what each step needs, in the README's "Recording real runs".
        </p>
      </>
    ),
  },
  {
    id: "how-it-works",
    title: "How it works",
    group: "Use Notary",
    body: (
      <>
        <p>
          Notary works a queue of refunds, partial refunds, plan changes and credits. It uses Crustdata for company context and Dodo Payments in test
          mode to execute. Before any irreversible action it checks, by pre-registered experiment, the tool behaviors that action depends on.
          Deterministic code makes every decision. Models only propose hypotheses and review beliefs.
        </p>
        <ol className="docs-steps">
          {pipeline.map((p, i) => (
            <li key={p.step}>
              <span className="docs-step-n" aria-hidden="true">
                {i + 1}
              </span>
              <div>
                <strong>{p.step}.</strong> {p.text}
              </div>
            </li>
          ))}
        </ol>
        <p>
          Two loops share one SQLite store. <C>notary notarize --tool &lt;crustdata|dodo&gt;</C> runs Read, Test and Challenge.{" "}
          <C>notary export --certificates</C> certifies. <C>notary run --queue &lt;file&gt;</C> enforces: for each item it enriches the company,
          picks an action by policy, checks the beliefs that action requires, and either sends the write through the guards or holds it with an
          evidence pack. Every run ends as a bundle with a sha256 content hash that can be replayed offline.
        </p>
        <p>
          Before a write that a guard would rewrite, a re-verification sentinel re-runs the certified experiment. An API that changes mid-run revokes
          the certificate and holds the action instead of moving the wrong amount.
        </p>
      </>
    ),
  },
  {
    id: "commands",
    title: "Commands",
    group: "Use Notary",
    body: (
      <>
        <p>
          Run each as <C>pnpm notary &lt;command&gt;</C> from the repo root. This lists the key flags; <C>--help</C> on any command shows all of
          them.
        </p>
        <RefTable
          caption="Notary CLI commands"
          rowKey={(c) => c.name}
          rows={COMMANDS}
          columns={[
            { header: "Command", className: "docs-col-name", cell: (c) => <C>{c.name}</C> },
            {
              header: "What it does",
              cell: (c) => (
                <>
                  {withFlags(c.summary)}
                  <span className="docs-needs">
                    <span className="docs-needs-label">Needs</span> {withFlags(c.needs)}
                  </span>
                </>
              ),
            },
            {
              header: "Key flags",
              className: "docs-col-flags",
              cell: (c) => (
                <ul className="docs-flags">
                  {c.flags.map((f) => {
                    const [flag, note] = splitFlag(f);
                    return (
                      <li key={f}>
                        <C>{flag}</C>
                        {note ? <span className="docs-flag-note"> {note}</span> : null}
                      </li>
                    );
                  })}
                </ul>
              ),
            },
          ]}
        />
        <p>
          Workspace scripts: <C>pnpm test</C> and <C>pnpm typecheck</C> across packages, <C>pnpm check:secrets</C> (the pre-commit secret scan),{" "}
          <C>pnpm --filter @notary/core seed:dodo --plan</C> (print the Dodo test world the seed would create, no network) and{" "}
          <C>node scripts/fresh-clone-check.mjs</C> (clone, install and replay with credentials stripped).
        </p>
      </>
    ),
  },
  {
    id: "running-live",
    title: "Running live",
    group: "Use Notary",
    body: (
      <>
        <p>
          <C>notary serve</C> starts the local API the dashboard uses in live mode. It binds <C>127.0.0.1:8787</C> by default and prints a session
          token once.
        </p>
        <CodeBlock code={`pnpm notary serve\n# in a second terminal\npnpm --filter @notary/web dev`} />
        <p>
          The dashboard probes <C>GET /api/health</C> at <C>VITE_NOTARY_API</C> (default <C>http://localhost:8787</C>). When it answers, the
          dashboard switches from the published files to live data and streams events over SSE. Reads need nothing more:
          <C>/api/health</C>, <C>/api/runs</C>, <C>/api/certificates</C>, <C>/api/bundles</C> and <C>/api/stream</C>.
        </p>
        <p>
          Starting runs (<C>POST /api/runs</C>), asking questions (<C>/api/ask</C>, <C>/api/chat</C>) and the approval desk (<C>/api/approvals</C>)
          also need the token, sent as <C>Authorization: Bearer &lt;token&gt;</C>. Paste it once in the dashboard; it is kept in this tab's
          session storage only, never in local storage or a URL.
        </p>
        <Note title="Localhost only">
          The token lives only in the server's memory: never written to a file, the event journal, a span or a log. Requests must come from a loopback
          address, name localhost in the Host header and, when sent, carry a loopback Origin; anything else gets 403, a missing or wrong token 401.
          Binding a non-loopback <C>--host</C> prints a warning. The hosted site is read-only and never contacts a local API.
        </Note>
      </>
    ),
  },
  {
    id: "dashboard",
    title: "The dashboard",
    group: "Use Notary",
    body: (
      <>
        <p>
          The dashboard lives at <Link to="/app">/app</Link>. Every number on it comes from a data file or the local API. Fixture data always carries its
          banner and is never mixed with live data in one chart or table.
        </p>
        <dl className="docs-pages">
          {dashboardPages.map((p) => (
            <div key={p.name}>
              <dt>
                <Link to={p.path}>{p.name}</Link>
              </dt>
              <dd>{p.text}</dd>
            </div>
          ))}
        </dl>
      </>
    ),
  },
  {
    id: "certificates",
    title: "Certificates and revocation",
    group: "Trust and safety",
    body: (
      <>
        <p>
          A certificate is a signed-off statement about documented API behavior, built only from hash-verified bundles, never from a model and never
          typed by hand. <C>pnpm notary export --certificates</C> writes one certificates file per tool and a <C>report.json</C> into the
          dashboard's <C>packages/web/public</C> folder, and the Notarized API Report to <C>export/REPORT.md</C>.
        </p>
        <ul>
          <li>
            <strong>Verdict:</strong> "matches docs", or "contradicts docs: docs say X, observed Y", where Y comes from the recorded probes.
          </li>
          <li>
            <strong>Scope:</strong> what the cited probes exercised, plus any narrower scope the adversary set.
          </li>
          <li>
            <strong>Evidence:</strong> the cited probes with their trace ids, and the adversary's verdict.
          </li>
          <li>
            <strong>Integrity:</strong> a deterministic id and a sha256 over the content, which the browser can check.
          </li>
        </ul>
        <p>
          Claims without a certificate are listed with the reason: abstained, downgraded by the adversary, refuted, never reviewed, or not tested.
        </p>
        <p>
          When later evidence un-learns a belief, its certificate is <strong>revoked</strong>. It stays listed with status revoked, a revocation id
          and time, and the evidence that triggered it. The guards compiled from that belief retire at once, so the next money action that depended
          on it is held. <C>pnpm notary demo --fixture --scenario change-api</C> walks through this on fixtures: the simulated Dodo changes the refund
          amount unit mid-run and the sentinel catches it.
        </p>
      </>
    ),
  },
  {
    id: "approvals",
    title: "Approvals",
    group: "Trust and safety",
    body: (
      <>
        <p>
          When a money action (a refund, plan change or wallet credit) depends on a belief that isn't certified, Notary holds it and attaches an
          evidence pack: the missing beliefs, related probes and trace receipts. Held items from local guarded live runs appear on the Approvals page
          when <C>notary serve</C> is running. Fixture runs are simulated and never listed.
        </p>
        <ul>
          <li>
            <strong>Reject</strong> needs a reason. It closes the item and makes no external call.
          </li>
          <li>
            <strong>Approve</strong> works only under the Dodo test-mode lock. You type the amount in minor units and it must equal the held action's
            amount. Each item can be decided once. Without <C>DODO_PAYMENTS_API_KEY</C> it returns <C>BLOCKED: DODO_PAYMENTS_API_KEY not set</C>{" "}
            and records nothing.
          </li>
        </ul>
        <p>
          An approved action runs once more through the guarded path. Every guard still applies, along with the pre-write reads and the
          read-back-before-retry rule; only the certificate gate is bypassed. Each decision is written to <C>runs/&lt;runId&gt;/approvals.json</C>{" "}
          and the run's timeline.
        </p>
      </>
    ),
  },
  {
    id: "replay",
    title: "Replay and verification",
    group: "Trust and safety",
    body: (
      <>
        <p>
          Every bundle carries a <C>contentHash</C>: the sha256 of its canonical JSON without that field. The CLI, the local API and the dashboard all
          recompute it on load. The dashboard does it in your browser and shows a visible error, withholding the data, on any mismatch.
        </p>
        <CodeBlock code={`pnpm notary replay\npnpm notary replay --bundle <id>`} />
        <p>
          <C>replay</C> re-runs each recorded live bundle from its cassettes with no environment at all, then compares every metric and every probe,
          belief and decision exactly. Exit 0 means all match, 1 a miss, tamper or mismatch, 3 nothing recorded.
        </p>
        <CodeBlock code="pnpm notary export" />
        <p>
          <C>export</C> regenerates <C>docs/EVALUATION.md</C>, <C>export/TOOLS.md</C> and <C>export/guards.json</C> from real bundles only, and copies
          the newest bundle per category into the dashboard's <C>packages/web/public</C> folder. Run it before committing: run directories are gitignored, so a fresh
          clone can replay only what export copied.
        </p>
      </>
    ),
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    group: "Help",
    body: (
      <>
        <dl className="docs-faq">
          {troubles.map((t, i) => (
            <div key={i}>
              <dt>{t.symptom}</dt>
              <dd>{t.fix}</dd>
            </div>
          ))}
        </dl>
      </>
    ),
  },
  {
    id: "privacy",
    title: "Privacy and data",
    group: "Help",
    body: (
      <>
        <ul>
          <li>
            <strong>Keys stay local.</strong> They live only in <C>.env</C> (gitignored). Models never see them, and the session adversary is denied
            <C>.env</C> reads.
          </li>
          <li>
            <strong>Cassettes are redacted</strong> before they are written: auth headers, secret-named fields and any <C>.env</C> value whose name
            looks secret.
          </li>
          <li>
            <strong>Traces.</strong> Spans go to neatlogs only when <C>NEATLOGS_API_KEY</C> is set, and always to the local{" "}
            <C>runs/&lt;runId&gt;/spans.jsonl</C>. Chat traces carry counts and record ids, never the message text, prompts or the token. Live chat history stays in the local <C>runs/</C> directory.
          </li>
          <li>
            <strong>Secret scan.</strong> <C>pnpm check:secrets</C> runs as a pre-commit hook. In a fresh clone, enable it with{" "}
            <C>git config core.hooksPath .githooks</C>.
          </li>
          <li>
            <strong>Test data only.</strong> The seeded queue is 20 hand-written requests against Dodo test-mode customers. No real person or real
            money is involved. Fixture and sample bundles are labelled and never counted as results.
          </li>
          <li>
            <strong>The hosted site</strong> reads published files only. It never contacts a local API, and its chat conversations stay in this
            tab's session storage.
          </li>
        </ul>
        <p>
          Source and issues: <a href={REPO_URL}>{REPO_URL.replace("https://", "")}</a>.
        </p>
      </>
    ),
  },
];
