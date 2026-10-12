/**
 * `notary guards coverage` (FR-17): every raw Crustdata/Dodo client method must be reachable only
 * through `wrap(op, …)` in createTools(), and every createTools() call must pass a real wrap.
 * Target: unguarded call sites = 0. Deliberately NOT exported from guards/index.ts: it loads the
 * TypeScript compiler, which only this command needs.
 *
 * What is checked, and how:
 *   1. Public methods are enumerated from the `class CrustdataClient` / `class DodoClient`
 *      declarations (no private/protected/static/#private members, no constructor).
 *   2. Wiring (always TypeScript): in src/tools/index.ts each `new <Client>(…)` must be passed to a
 *      function together with an ops table, and that function must call its wrap parameter. Each
 *      ops-table entry is then the op's single GUARDED site. A construction anywhere else is UNGUARDED.
 *   3. Raw callers of each method, by backend:
 *      - `entire` (default when `entire graph` is installed; ENTIRE_CHECKED_WITH): one bulk
 *        `entire graph edges --worktree --relation CALLS,ASYNC_CALLS,CONSTRUCTS --format ndjson`
 *        over the repo; any relation into a public raw-client method from src/ or scripts/ is a raw
 *        caller (exact lines then from `entire graph neighbors --format json`). See section 3b.
 *      - `tsc` (fallback, always available): a checker walk over packages/core/{src,scripts}. A
 *        property access is raw when it resolves to the method's own symbol or its receiver is typed
 *        as the client class. `tools.dodo.x()` on the createTools() surface resolves to a mapped
 *        (Pick) symbol and is not a raw reference.
 *      Any raw reference is UNGUARDED: the guarded route is dynamic (`client[method]` inside the
 *      wrap loop), so no static raw call is legitimate.
 *   4. createTools() calls (always TypeScript, resolved by symbol, so aliases count): the argument's
 *      type must have a non-optional `wrap`, and that wrap must not resolve to `identityWrap`.
 *      Exceptions are RAW_BY_DESIGN only, per function and site count (not per file).
 */
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export type CoverageStatus = "guarded" | "raw-by-design" | "UNGUARDED";
export type CoverageBackend = "entire" | "tsc";

export interface CoverageSite {
  /** `crustdata.enrichCompany`, `new DodoClient`, or `createTools()`. */
  op: string;
  /** Relative to the display root (the repo root for the real run), forward slashes. */
  file: string;
  line: number;
  status: CoverageStatus;
  detail: string;
}

export interface CoverageOp {
  op: string;
  className: string;
  method: string;
  declaredAt: string;
  /** False when the method is public but not in the ops table (no route at all). */
  exposed: boolean;
}

export interface CoverageReport {
  backend: CoverageBackend;
  backendNote: string;
  /** Present only when backend is `entire`: what Entire's code graph covered (version, tree, edge counts). */
  entire?: EntireGraphRun;
  ops: CoverageOp[];
  /** Raw-method references and raw-client constructions. */
  sites: CoverageSite[];
  createToolsCalls: CoverageSite[];
  totals: { ops: number; sites: number; guarded: number; rawByDesign: number; unguarded: number };
  /** The FR-17 metric. */
  unguarded_call_sites: number;
}

export interface ClientSpec {
  className: string;
  /** Relative to projectDir. */
  file: string;
  /** Op prefix when a method has no ops-table entry. */
  opPrefix: string;
}

export interface AllowEntry {
  /** Relative to projectDir. */
  file: string;
  /** `no-wrap`: createTools() without a wrap. `identity-wrap`: a wrap that can be identityWrap. */
  kind: "no-wrap" | "identity-wrap";
  /** Enclosing function of the allowed call(s) (see enclosingFunctionName). */
  fn: string;
  /** How many createTools() calls in `fn` this entry covers; one more is UNGUARDED. */
  sites: number;
  reason: string;
}

export interface CoverageConfig {
  /** Directory holding tsconfig.json. */
  projectDir: string;
  /** Paths in the report are relative to this (and it is `entire graph --repo`). */
  displayRoot: string;
  /** Directories scanned for call sites, relative to projectDir. Tests are out of scope. */
  scanDirs: string[];
  /** The one module allowed to touch the raw clients, relative to projectDir. */
  toolsIndex: string;
  clients: ClientSpec[];
  allowList: AllowEntry[];
}

/**
 * The only createTools() calls allowed to run without a guarded wrap. Keep this minimal: each entry
 * needs a reason a reviewer would accept, and it covers createTools() calls only, never a raw
 * client reference. Each entry names the enclosing function and the exact number of sites in it
 * (AUDIT-10): a new raw call elsewhere in the same file is still UNGUARDED.
 */
export const RAW_BY_DESIGN: readonly AllowEntry[] = [
  {
    file: "src/checker/recon.ts",
    kind: "no-wrap",
    fn: "runRecon",
    sites: 1,
    reason: "probing: the recon sweep measures the raw tool behavior that guards would hide (DECISIONS #56)",
  },
  {
    file: "src/reflect/notarize.ts",
    kind: "no-wrap",
    fn: "notarize",
    sites: 1,
    reason: "probing: probes must see the raw response to confirm or refute a belief (DECISIONS #56)",
  },
  {
    file: "src/reflect/notarize.ts",
    kind: "no-wrap",
    fn: "rawReplayProbeIo",
    sites: 1,
    reason: "probing (replay of recorded probes, incl. drift): probes must see the raw response (DECISIONS #56)",
  },
  {
    file: "src/reflect/notarize.ts",
    kind: "no-wrap",
    fn: "sentinelProbeTools",
    sites: 1,
    reason: "probing: re-verification sentinel probes must see the raw response, never the guards they re-verify (DECISIONS #56, #105)",
  },
  {
    file: "scripts/seed-dodo.ts",
    kind: "no-wrap",
    fn: "seed",
    sites: 1,
    reason: "seeding: builds the test-mode world (including the states guards exist to block) before any belief exists",
  },
  {
    file: "src/queue/run.ts",
    kind: "identity-wrap",
    fn: "runQueue",
    sites: 2,
    reason: "naive baseline: `gctx?.wrap ?? identityWrap` is identity only for --variant naive, the unguarded control",
  },
];

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function defaultCoverageConfig(): CoverageConfig {
  return {
    projectDir: PACKAGE_DIR,
    displayRoot: resolve(PACKAGE_DIR, "../.."),
    scanDirs: ["src", "scripts"],
    toolsIndex: "src/tools/index.ts",
    clients: [
      { className: "CrustdataClient", file: "src/tools/crustdata.ts", opPrefix: "crustdata" },
      { className: "DodoClient", file: "src/tools/dodo.ts", opPrefix: "dodo" },
    ],
    allowList: [...RAW_BY_DESIGN],
  };
}

/** Whether `entire graph` is installed (Entire CLI plus the graph plugin). */
export function entireAvailable(bin = "entire"): boolean {
  const r = spawnSync(bin, ["graph", "version"], { encoding: "utf8", timeout: 15_000 });
  return !r.error && r.status === 0;
}

export interface RunCoverageOptions {
  config?: CoverageConfig;
  /** auto: entire when `entire graph version` succeeds, else tsc. */
  backend?: "auto" | CoverageBackend;
  entireBin?: string;
  /** Replaces spawning `entire` (tests feed captured real output). */
  runEntire?: RunEntire;
}

export function runCoverage(opts: RunCoverageOptions = {}): CoverageReport {
  const config = opts.config ?? defaultCoverageConfig();
  const want = opts.backend ?? "auto";
  const bin = opts.entireBin ?? "entire";
  const project = loadProject(config);
  const methods = enumerateMethods(project, config);
  const wiring = checkWiring(project, config, methods);
  const createToolsCalls = checkCreateToolsCalls(project, config);

  let backend: CoverageBackend = "tsc";
  let backendNote = "TypeScript checker walk over " + config.scanDirs.join(", ") + " (entire not on PATH)";
  let rawRefs: CoverageSite[] | undefined;
  let graph: EntireGraphRun | undefined;
  if (want === "entire" || (want === "auto" && entireAvailable(bin))) {
    try {
      const got = entireRawCallers(config, methods, wiring.opByMethod, opts.runEntire ?? spawnEntireWith(bin), wiring.sites);
      rawRefs = got.sites;
      graph = got.graph;
      backend = "entire";
      backendNote = `entire graph edges (entire-graph ${got.graph.providerVersion}, ${got.graph.worktree ? "working tree" : "HEAD"}): ${got.graph.callEdges} call and ${got.graph.constructEdges} construct relations scanned, ${got.graph.clientEdges} reach a raw client; wiring and createTools() checks via TypeScript`;
    } catch (err) {
      if (want === "entire") throw err;
      backendNote = `TypeScript checker walk (entire graph failed: ${(err as Error).message.split("\n")[0]})`;
    }
  } else if (want === "tsc") {
    backendNote = "TypeScript checker walk over " + config.scanDirs.join(", ");
  }
  rawRefs ??= tscRawReferences(project, config, methods, wiring.opByMethod);

  const sites = [...wiring.sites, ...rawRefs].sort(bySite);
  const all = [...sites, ...createToolsCalls];
  const count = (s: CoverageStatus) => all.filter((x) => x.status === s).length;
  const ops: CoverageOp[] = methods.map((m) => ({
    op: wiring.opByMethod.get(m.key) ?? `${m.client.opPrefix}.${m.name}`,
    className: m.client.className,
    method: m.name,
    declaredAt: `${m.file}:${m.line}`,
    exposed: wiring.opByMethod.has(m.key),
  }));
  const unguarded = count("UNGUARDED");
  return {
    backend,
    backendNote,
    ...(backend === "entire" && graph ? { entire: graph } : {}),
    ops,
    sites,
    createToolsCalls,
    totals: { ops: ops.length, sites: all.length, guarded: count("guarded"), rawByDesign: count("raw-by-design"), unguarded },
    unguarded_call_sites: unguarded,
  };
}

export function coverageExitCode(report: CoverageReport): 0 | 1 {
  return report.unguarded_call_sites > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Project loading

interface Project {
  program: ts.Program;
  checker: ts.TypeChecker;
  config: CoverageConfig;
  /** Scanned source files (under scanDirs, not .d.ts). */
  scanned: ts.SourceFile[];
}

const norm = (p: string): string => {
  const s = resolve(p).split(sep).join("/");
  return process.platform === "win32" ? s.toLowerCase() : s;
};

function loadProject(config: CoverageConfig): Project {
  const cfgPath = join(config.projectDir, "tsconfig.json");
  const read = ts.readConfigFile(cfgPath, (p) => ts.sys.readFile(p));
  if (read.error) throw new Error(`guards coverage: cannot read ${cfgPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, config.projectDir);
  const roots = config.scanDirs.map((d) => norm(join(config.projectDir, d)) + "/");
  const inScope = (f: string) => roots.some((r) => norm(f).startsWith(r));
  const program = ts.createProgram({ rootNames: parsed.fileNames.filter(inScope), options: { ...parsed.options, noEmit: true } });
  const scanned = program.getSourceFiles().filter((sf) => !sf.isDeclarationFile && inScope(sf.fileName));
  return { program, checker: program.getTypeChecker(), config, scanned };
}

function sourceFile(project: Project, rel: string): ts.SourceFile {
  const want = norm(join(project.config.projectDir, rel));
  const sf = project.program.getSourceFiles().find((s) => norm(s.fileName) === want);
  if (!sf) throw new Error(`guards coverage: ${rel} is not in the program (check scanDirs / tsconfig include)`);
  return sf;
}

function display(project: Project, fileName: string): string {
  return relative(project.config.displayRoot, fileName).split(sep).join("/");
}

function lineOf(node: ts.Node): number {
  const sf = node.getSourceFile();
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function resolved(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  let sym = checker.getSymbolAtLocation(node);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  return sym;
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

/**
 * Name of the nearest enclosing named function: a function/method declaration's name, or the
 * variable/property an arrow function or function expression is assigned to. `<module>` at top level.
 */
export function enclosingFunctionName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText();
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      if (ts.isFunctionExpression(n) && n.name) return n.name.text;
      const p = n.parent;
      if ((ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && p.name) return p.name.getText();
    }
  }
  return "<module>";
}

function unwrapExpr(e: ts.Expression): ts.Expression {
  while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e) || ts.isTypeAssertionExpression(e)) {
    e = e.expression;
  }
  return e;
}

// ---------------------------------------------------------------------------------------------
// 1. Enumerate public methods from the class declarations

interface RawMethod {
  key: string; // Class.method
  name: string;
  client: ClientSpec;
  classSymbol: ts.Symbol;
  symbol: ts.Symbol;
  /** display path */
  file: string;
  line: number;
}

function enumerateMethods(project: Project, config: CoverageConfig): RawMethod[] {
  const out: RawMethod[] = [];
  for (const client of config.clients) {
    const sf = sourceFile(project, client.file);
    const cls = sf.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === client.className);
    if (!cls?.name) throw new Error(`guards coverage: class ${client.className} not found in ${client.file}`);
    const classSymbol = resolved(project.checker, cls.name);
    if (!classSymbol) throw new Error(`guards coverage: no symbol for ${client.className}`);
    for (const member of cls.members) {
      const isMethod = ts.isMethodDeclaration(member);
      const isFnProp =
        ts.isPropertyDeclaration(member) && !!member.initializer && (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer));
      if (!isMethod && !isFnProp) continue;
      if (!member.name || !ts.isIdentifier(member.name)) continue; // skips #private and computed names
      const flags = ts.getCombinedModifierFlags(member);
      if (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Static)) continue;
      const symbol = project.checker.getSymbolAtLocation(member.name);
      if (!symbol) continue;
      out.push({
        key: `${client.className}.${member.name.text}`,
        name: member.name.text,
        client,
        classSymbol,
        symbol,
        file: display(project, sf.fileName),
        line: lineOf(member.name),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 2. Wiring in the tools index: new Client() -> F(client, OPS, wrap) where F calls its wrap param

interface Wiring {
  sites: CoverageSite[];
  /** Class.method -> op name, for exposed methods only. */
  opByMethod: Map<string, string>;
}

function functionDeclOf(
  checker: ts.TypeChecker,
  callee: ts.Expression,
): ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined {
  const sym = resolved(checker, callee);
  const decl = sym?.valueDeclaration;
  if (!decl) return undefined;
  if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) return decl;
  if (ts.isVariableDeclaration(decl) && decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
    return decl.initializer;
  }
  return undefined;
}

function objectLiteralOf(checker: ts.TypeChecker, e: ts.Expression): ts.ObjectLiteralExpression | undefined {
  const x = unwrapExpr(e);
  if (ts.isObjectLiteralExpression(x)) return x;
  const decl = resolved(checker, x)?.valueDeclaration;
  if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
    const init = unwrapExpr(decl.initializer);
    if (ts.isObjectLiteralExpression(init)) return init;
  }
  return undefined;
}

function checkWiring(project: Project, config: CoverageConfig, methods: RawMethod[]): Wiring {
  const { checker } = project;
  const sites: CoverageSite[] = [];
  const opByMethod = new Map<string, string>();
  const classes = new Map(methods.map((m) => [m.classSymbol, m.client] as const));
  for (const client of config.clients) {
    // Classes with no public methods still need their constructions checked.
    const sf = sourceFile(project, client.file);
    const cls = sf.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === client.className);
    const sym = cls?.name ? resolved(checker, cls.name) : undefined;
    if (sym && !classes.has(sym)) classes.set(sym, client);
  }
  const indexSf = sourceFile(project, config.toolsIndex);

  for (const sf of project.scanned) {
    const inIndex = sf === indexSf;
    walk(sf, (n) => {
      if (!ts.isNewExpression(n)) return;
      const sym = resolved(checker, n.expression);
      const client = sym && classes.get(sym);
      if (!client) return;
      const at = { op: `new ${client.className}`, file: display(project, sf.fileName), line: lineOf(n) };
      if (!inIndex) {
        sites.push({ ...at, status: "UNGUARDED", detail: `raw client constructed outside ${config.toolsIndex}` });
        return;
      }
      const route = findRoute(project, indexSf, n);
      if (!route) {
        sites.push({ ...at, status: "UNGUARDED", detail: "constructed but never passed to a function that calls its wrap parameter" });
        return;
      }
      sites.push({ ...at, status: "guarded", detail: route.text });
      for (const prop of route.ops.properties) {
        if (!ts.isPropertyAssignment(prop) || !prop.name || !(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) continue;
        const method = methods.find((m) => m.client === client && m.name === prop.name.getText().replace(/^["']|["']$/g, ""));
        if (!method) continue;
        const init = unwrapExpr(prop.initializer);
        const op = ts.isStringLiteralLike(init) ? init.text : `${client.opPrefix}.${method.name}`;
        opByMethod.set(method.key, op);
        sites.push({ op, file: display(project, indexSf.fileName), line: lineOf(prop), status: "guarded", detail: route.text });
      }
    });
  }
  return { sites, opByMethod };
}

function findRoute(project: Project, indexSf: ts.SourceFile, ctor: ts.NewExpression): { ops: ts.ObjectLiteralExpression; text: string } | undefined {
  const { checker } = project;
  const parent = ctor.parent;
  const varSym = ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? checker.getSymbolAtLocation(parent.name) : undefined;
  const isClientArg = (a: ts.Expression) => a === ctor || (!!varSym && ts.isIdentifier(a) && checker.getSymbolAtLocation(a) === varSym);
  let found: { ops: ts.ObjectLiteralExpression; text: string } | undefined;
  walk(indexSf, (n) => {
    if (found || !ts.isCallExpression(n)) return;
    const clientIdx = n.arguments.findIndex(isClientArg);
    if (clientIdx < 0) return;
    const fn = functionDeclOf(checker, n.expression);
    if (!fn?.body) return;
    const opsIdx = n.arguments.findIndex((a, i) => i !== clientIdx && !!objectLiteralOf(checker, a));
    if (opsIdx < 0) return;
    const ops = objectLiteralOf(checker, n.arguments[opsIdx]!)!;
    // The wrap parameter: one the function body CALLS, other than the client and ops parameters.
    for (let k = 0; k < fn.parameters.length; k++) {
      if (k === clientIdx || k === opsIdx || !n.arguments[k]) continue;
      const param = fn.parameters[k]!;
      if (!ts.isIdentifier(param.name)) continue;
      const pSym = checker.getSymbolAtLocation(param.name);
      let calls = false;
      walk(fn.body, (b) => {
        if (!calls && ts.isCallExpression(b) && ts.isIdentifier(b.expression) && checker.getSymbolAtLocation(b.expression) === pSym) calls = true;
      });
      if (calls) {
        const args = n.arguments.map((a) => a.getText(indexSf)).join(", ");
        found = { ops, text: `${n.expression.getText(indexSf)}(${args}) -> ${param.name.text}(op, raw.bind(client))` };
        return;
      }
    }
  });
  return found;
}

// ---------------------------------------------------------------------------------------------
// 3a. tsc backend: raw references to client methods

function tscRawReferences(project: Project, config: CoverageConfig, methods: RawMethod[], opByMethod: Map<string, string>): CoverageSite[] {
  const { checker } = project;
  const byName = new Map<string, RawMethod[]>();
  for (const m of methods) byName.set(m.name, [...(byName.get(m.name) ?? []), m]);
  const classSyms = new Set(methods.map((m) => m.classSymbol));
  const out: CoverageSite[] = [];

  const receiverIsClient = (expr: ts.Expression): ts.Symbol | undefined => {
    const t = checker.getTypeAtLocation(expr);
    const parts = t.isUnion() || t.isIntersection() ? t.types : [t];
    for (const p of parts) {
      const s = p.getSymbol() ?? (p.isTypeParameter() ? p.getConstraint()?.getSymbol() : undefined);
      if (s && classSyms.has(s)) return s;
    }
    return undefined;
  };
  const record = (node: ts.Node, m: RawMethod, how: string) => {
    const file = display(project, node.getSourceFile().fileName);
    const own = norm(node.getSourceFile().fileName) === norm(join(config.projectDir, m.client.file));
    out.push({
      op: opByMethod.get(m.key) ?? `${m.client.opPrefix}.${m.name}`,
      file,
      line: lineOf(node),
      status: "UNGUARDED",
      detail: own ? `${how} inside ${m.client.className} bypasses this op's wrap` : `${how} on a raw ${m.client.className}`,
    });
  };
  const match = (name: string, propSym: ts.Symbol | undefined, recv: ts.Expression | undefined): RawMethod | undefined => {
    const cands = byName.get(name);
    if (!cands) return undefined;
    const direct = cands.find((m) => m.symbol === propSym);
    if (direct) return direct;
    const cls = recv ? receiverIsClient(recv) : undefined;
    return cls ? cands.find((m) => m.classSymbol === cls) : undefined;
  };

  for (const sf of project.scanned) {
    walk(sf, (n) => {
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.name)) {
        const m = match(n.name.text, checker.getSymbolAtLocation(n.name), n.expression);
        if (m) record(n, m, `${n.getText(sf).replace(/\s+/g, " ")}`);
      } else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) {
        const m = match(n.argumentExpression.text, checker.getSymbolAtLocation(n.argumentExpression), n.expression);
        if (m) record(n, m, `${n.getText(sf).replace(/\s+/g, " ")}`);
      } else if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer) {
        for (const el of n.name.elements) {
          const key = el.propertyName ?? el.name;
          if (!ts.isIdentifier(key)) continue;
          const m = match(key.text, undefined, n.initializer);
          if (m) record(el, m, `destructured \`${key.text}\``);
        }
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 3b. entire backend

/**
 * The `entire` backend, checked against a real install on 2026-10-12: Entire CLI 0.11.4 (GitHub
 * release entireio/cli v0.11.4) with the official graph plugin, entire-graph v0.4.0
 * (`entire plugin install graph`). Reality differs from the docs read on 2026-10-10 (DECISIONS #61,
 * #99, #102): `entire graph` is a plugin, not a built-in; `neighbors` accepts `--format json|text|agent`
 * and prints JSON by default; and every graph query re-indexes a dirty working tree (~50 s for this
 * repo), so one `neighbors` call per method (22 methods) would take ~18 minutes.
 *
 * So the backend makes ONE bulk call, `entire graph edges --worktree --relation
 * CALLS,ASYNC_CALLS,CONSTRUCTS --format ndjson`, and keeps the relations whose destination is a
 * public method of a raw client class (`<repo>:TypeScript:<file>:method:<Class>.<method>`) and whose
 * source file is under the scanned dirs (src/, scripts/; tests are out of scope, as with tsc).
 * Bulk edges carry the caller's span, not the call line, so for a method that does have raw callers
 * the exact lines come from one `entire graph neighbors --direction in --format json` call each.
 * CONSTRUCTS edges to a client class outside src/tools/index.ts are raw constructions too (the
 * TypeScript wiring check sees them as well; a construction only Entire found is added).
 */
export const ENTIRE_CHECKED_WITH = "Entire CLI 0.11.4 + entire-graph v0.4.0 (checked 2026-10-12)";

/** One relation from `entire graph edges` (real field names: type, from_id, to_id, evidence[]). */
export interface EntireEdge {
  type: string;
  fromId: string;
  toId: string;
  resolution?: string;
  confidence?: number;
  /** First evidence record: the caller's span for CALLS (start line of the enclosing body). */
  evidence?: { file: string; line: number; detail?: string };
}

export interface EntireEdgesParse {
  provider: string;
  providerVersion: string;
  repoKey: string;
  commit: string | null;
  tree: string | null;
  /** True when the summary carries W_WORKTREE_SNAPSHOT (the working tree, not HEAD, was read). */
  worktree: boolean;
  completeness: string;
  partialFailures: number;
  /** Files Entire could not parse (summary.partial_failures), e.g. E_MINIFIED for a one-line JSON. */
  failedFiles: Array<{ code: string; file: string }>;
  edges: EntireEdge[];
}

/**
 * Parse `entire graph edges --format ndjson`: a header record (schema_version, provider…), relation
 * records (record_type "relation"), then a summary record. A stream without its summary was cut short
 * and is rejected, as is anything that is not entire-graph output.
 */
export function parseEntireEdges(ndjson: string): EntireEdgesParse {
  const lines = ndjson.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error("entire graph edges printed nothing");
  const parse = (l: string, i: number): Record<string, unknown> => {
    try {
      const v = JSON.parse(l) as unknown;
      if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
      return v as Record<string, unknown>;
    } catch {
      throw new Error(`entire graph edges: line ${i + 1} is not a JSON object`);
    }
  };
  const header = parse(lines[0]!, 0);
  if (header.provider !== "entire-graph" || typeof header.schema_version !== "string") {
    throw new Error(`entire graph edges: unrecognized header ${JSON.stringify(lines[0]!.slice(0, 80))}`);
  }
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const edges: EntireEdge[] = [];
  let summary: Record<string, unknown> | undefined;
  for (let i = 1; i < lines.length; i++) {
    const rec = parse(lines[i]!, i);
    if (rec.record_type === "summary") {
      summary = rec;
      continue;
    }
    if (rec.record_type !== "relation") continue;
    const type = str(rec.type);
    const fromId = str(rec.from_id);
    const toId = str(rec.to_id);
    if (!type || !fromId || !toId) throw new Error(`entire graph edges: relation on line ${i + 1} lacks type/from_id/to_id`);
    const ev = Array.isArray(rec.evidence) ? (rec.evidence[0] as Record<string, unknown> | undefined) : undefined;
    const evFile = ev ? str(ev.file_path) : null;
    edges.push({
      type,
      fromId,
      toId,
      ...(str(rec.resolution) ? { resolution: rec.resolution as string } : {}),
      ...(typeof rec.confidence === "number" ? { confidence: rec.confidence } : {}),
      ...(ev && evFile
        ? {
            evidence: {
              file: evFile.split("\\").join("/"),
              line: typeof ev.start_line === "number" ? ev.start_line : 0,
              ...(str(ev.detail) ? { detail: ev.detail as string } : {}),
            },
          }
        : {}),
    });
  }
  if (!summary) throw new Error("entire graph edges: no summary record (the stream was cut short)");
  const stats = (summary.stats ?? {}) as Record<string, unknown>;
  const warnings = Array.isArray(summary.warnings) ? (summary.warnings as Array<Record<string, unknown>>) : [];
  const failures = Array.isArray(summary.partial_failures) ? (summary.partial_failures as Array<Record<string, unknown>>) : [];
  const failedFiles = failures.map((f) => ({ code: str(f.code) ?? "?", file: (str(f.file_path) ?? "").split("\\").join("/") }));
  return {
    provider: "entire-graph",
    providerVersion: str(header.provider_version) ?? "unknown",
    repoKey: str(header.repo_key) ?? "",
    commit: str(header.commit),
    tree: str(header.tree),
    worktree: warnings.some((w) => w.code === "W_WORKTREE_SNAPSHOT"),
    completeness: str(stats.completeness_level) ?? "unknown",
    partialFailures: typeof stats.partial_failures === "number" ? stats.partial_failures : failedFiles.length,
    failedFiles,
    edges,
  };
}

/** `<repoKey>:<Language>:<path>:<kind>:<qualified name>` (stable-symbol-id-v1); file ids are `<repoKey>:file:<path>`. */
export function parseEntireSymbolId(id: string): { language: string; path: string; kind: string; name: string } | null {
  const parts = id.split(":");
  if (parts.length < 5 || parts[1] === "file") return null;
  return { language: parts[1]!, path: parts[2]!, kind: parts[3]!, name: parts.slice(4).join(":") };
}

/** The bulk call (verified flags; see ENTIRE_CHECKED_WITH). */
export function entireEdgesArgs(repo: string): string[] {
  return ["graph", "edges", "--repo", repo, "--format", "ndjson", "--worktree", "--relation", "CALLS,ASYNC_CALLS,CONSTRUCTS"];
}

/** Per-method caller lookup, used only to get exact call lines for a method that has raw callers. */
export function entireNeighborsArgs(repo: string, method: { className: string; name: string }): string[] {
  return [
    "graph", "neighbors",
    "--repo", repo,
    "--symbol", `${method.className}.${method.name}`,
    "--relation", "CALLS",
    "--direction", "in",
    "--limit", "500",
    "--internal-only",
    "--format", "json",
  ];
}

export interface EntireCaller {
  caller: string;
  /** As reported (relative to --repo). */
  file: string;
  /** 0 when Entire reported no line. */
  line: number;
  resolution?: string;
  confidence?: number;
  additionalSites?: number;
}

export interface EntireNeighborsParse {
  callers: EntireCaller[];
  exactMatch: boolean;
  disambiguationRequired: boolean;
  truncated: boolean;
}

/** Parse `entire graph neighbors --format json` (real shape: matches[].incoming[].endpoint / call_site). */
export function parseEntireNeighbors(stdout: string): EntireNeighborsParse {
  const body = stdout.replace(/^\uFEFF/, "").trim();
  if (!body.startsWith("{")) throw new Error(`unrecognized entire graph neighbors output (expected JSON): ${JSON.stringify(body.slice(0, 80))}`);
  const raw = JSON.parse(body) as {
    disambiguation_required?: boolean;
    truncated?: boolean;
    fuzzy_match?: boolean;
    matches?: Array<{
      incoming?: Array<{
        direction?: string;
        endpoint?: { name?: string; qualified_name?: string; file_path?: string; start_line?: number };
        call_site?: { file_path?: string; line?: number; additional_sites?: number } | null;
        resolution?: string;
        confidence?: number;
      }>;
    }>;
  };
  const callers: EntireCaller[] = [];
  for (const match of raw.matches ?? []) {
    for (const edge of match.incoming ?? []) {
      if (edge.direction && edge.direction !== "in") continue;
      const ep = edge.endpoint ?? {};
      const file = edge.call_site?.file_path ?? ep.file_path;
      if (!file) continue;
      callers.push({
        caller: ep.qualified_name ?? ep.name ?? "?",
        file: file.split("\\").join("/"),
        line: edge.call_site?.line ?? ep.start_line ?? 0,
        ...(edge.resolution ? { resolution: edge.resolution } : {}),
        ...(edge.confidence === undefined ? {} : { confidence: edge.confidence }),
        ...(edge.call_site?.additional_sites ? { additionalSites: edge.call_site.additional_sites } : {}),
      });
    }
  }
  return {
    callers,
    exactMatch: (raw.matches?.length ?? 0) > 0 && raw.fuzzy_match !== true,
    disambiguationRequired: raw.disambiguation_required === true,
    truncated: raw.truncated === true,
  };
}

/** What the entire backend saw, for the report and the dashboard (packages/web/public/evidence/entire.json). */
export interface EntireGraphRun {
  provider: string;
  providerVersion: string;
  commit: string | null;
  tree: string | null;
  worktree: boolean;
  completeness: string;
  partialFailures: number;
  /** Files Entire skipped outside the scanned source (they cannot hide a raw call). */
  skippedFiles: string[];
  /** CALLS + ASYNC_CALLS relations in the stream. */
  callEdges: number;
  /** CONSTRUCTS relations in the stream. */
  constructEdges: number;
  /** Of those, relations that reach a public raw-client method or construct a raw client. */
  clientEdges: number;
  command: string;
}

type RunEntire = (args: string[]) => { status: number | null; stdout: string; stderr: string; error?: Error };

const spawnEntireWith =
  (bin: string): RunEntire =>
  (args) => {
    const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 600_000, windowsHide: true });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(r.error ? { error: r.error } : {}) };
  };

/**
 * Raw callers and constructions of the client classes, from Entire's code graph. Exported with an
 * injectable runner so tests feed real captured output without spawning Entire.
 */
export function entireRawCallers(
  config: CoverageConfig,
  methods: Array<{ key: string; name: string; file: string; client: ClientSpec }>,
  opByMethod: Map<string, string>,
  run: RunEntire,
  wiringSites: CoverageSite[] = [],
): { sites: CoverageSite[]; graph: EntireGraphRun } {
  const scanRoots = config.scanDirs.map((d) => relative(config.displayRoot, join(config.projectDir, d)).split(sep).join("/") + "/");
  const toolsIndex = relative(config.displayRoot, join(config.projectDir, config.toolsIndex)).split(sep).join("/");
  const args = entireEdgesArgs(config.displayRoot);
  const r = run(args);
  if (r.error || r.status !== 0) throw new Error(`entire ${args.join(" ")} failed: ${r.error?.message ?? r.stderr.trim()}`);
  const parsed = parseEntireEdges(r.stdout);
  // A file Entire skipped matters only if it is source we scan (a minified JSON inbox file does not).
  const inScope = (file: string) => scanRoots.some((root) => file.startsWith(root));
  const blind = parsed.failedFiles.filter((f) => !f.file || inScope(f.file));
  if (blind.length > 0 || parsed.failedFiles.length < parsed.partialFailures) {
    const list = blind.map((f) => `${f.code} ${f.file || "(no file)"}`).join(", ") || `${parsed.partialFailures} unlisted`;
    throw new Error(`entire graph could not parse scanned source (${list}); the call graph is incomplete`);
  }

  const byTarget = new Map<string, (typeof methods)[number]>();
  for (const m of methods) byTarget.set(`${m.file}\0${m.key}`, m);
  const classFiles = new Map(methods.map((m) => [m.client.className, m.file]));

  const out: CoverageSite[] = [];
  const hit = new Set<(typeof methods)[number]>();
  let callEdges = 0;
  let constructEdges = 0;
  let clientEdges = 0;
  for (const e of parsed.edges) {
    const to = parseEntireSymbolId(e.toId);
    const from = parseEntireSymbolId(e.fromId);
    if (e.type === "CALLS" || e.type === "ASYNC_CALLS") {
      callEdges++;
      if (!to || to.kind !== "method") continue;
      const m = byTarget.get(`${to.path}\0${to.name}`);
      if (!m) continue;
      clientEdges++;
      const file = e.evidence?.file ?? from?.path ?? "";
      if (inScope(file)) hit.add(m);
    } else if (e.type === "CONSTRUCTS") {
      constructEdges++;
      if (!to || to.kind !== "class" || classFiles.get(to.name) !== to.path) continue;
      clientEdges++;
      const file = e.evidence?.file ?? from?.path ?? "";
      if (!inScope(file) || file === toolsIndex) continue;
      // The TypeScript wiring check reports constructions too; add only one it did not see.
      if (wiringSites.some((s) => s.op === `new ${to.name}` && s.file === file)) continue;
      out.push({
        op: `new ${to.name}`,
        file,
        line: e.evidence?.line ?? 0,
        status: "UNGUARDED",
        detail: `constructed in ${from?.name ?? "?"} outside ${toolsIndex} (entire graph CONSTRUCTS, ${e.resolution ?? "?"})`,
      });
    }
  }

  // Exact call lines for the (normally zero) methods that do have raw callers.
  for (const m of methods) {
    if (!hit.has(m)) continue;
    const nargs = entireNeighborsArgs(config.displayRoot, { className: m.client.className, name: m.name });
    const nr = run(nargs);
    if (nr.error || nr.status !== 0) throw new Error(`entire ${nargs.join(" ")} failed: ${nr.error?.message ?? nr.stderr.trim()}`);
    const n = parseEntireNeighbors(nr.stdout);
    if (n.disambiguationRequired) throw new Error(`entire graph could not resolve ${m.key} to one definition`);
    if (!n.exactMatch) throw new Error(`entire graph found no exact definition for ${m.key}`);
    if (n.truncated) throw new Error(`entire graph truncated the callers of ${m.key}`);
    const op = opByMethod.get(m.key) ?? `${m.client.opPrefix}.${m.name}`;
    for (const c of n.callers) {
      const file = isAbsolute(c.file) ? relative(config.displayRoot, c.file).split(sep).join("/") : c.file;
      if (!inScope(file)) continue;
      const notes = [c.resolution, c.confidence === undefined ? undefined : String(c.confidence), c.additionalSites ? `+${c.additionalSites} more in this caller` : undefined]
        .filter(Boolean)
        .join(" ");
      out.push({ op, file, line: c.line, status: "UNGUARDED", detail: `called from ${c.caller}${notes ? ` [${notes}]` : ""} (entire graph)` });
    }
  }

  return {
    sites: out,
    graph: {
      provider: parsed.provider,
      providerVersion: parsed.providerVersion,
      commit: parsed.commit,
      tree: parsed.tree,
      worktree: parsed.worktree,
      completeness: parsed.completeness,
      partialFailures: parsed.partialFailures,
      skippedFiles: parsed.failedFiles.map((f) => `${f.file} (${f.code})`),
      callEdges,
      constructEdges,
      clientEdges,
      command: `entire ${entireEdgesArgs(".").join(" ")}`,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 4. createTools() calls must pass a non-identity wrap

function checkCreateToolsCalls(project: Project, config: CoverageConfig): CoverageSite[] {
  const { checker } = project;
  const indexSf = sourceFile(project, config.toolsIndex);
  const exportOf = (name: string) => {
    const mod = checker.getSymbolAtLocation(indexSf);
    return mod ? checker.getExportsOfModule(mod).map((s) => (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s)).find((s) => s.name === name) : undefined;
  };
  const createToolsSym = exportOf("createTools");
  if (!createToolsSym) throw new Error(`guards coverage: ${config.toolsIndex} does not export createTools`);
  const identitySym = exportOf("identityWrap");

  const reachesIdentity = (e: ts.Node, seen: Set<ts.Symbol>, depth: number): boolean => {
    if (!identitySym) return false;
    let hit = false;
    walk(e, (n) => {
      if (hit || !ts.isIdentifier(n)) return;
      // `{ wrap }`: the name resolves to the property; the value is the local variable.
      const s = ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n ? checker.getShorthandAssignmentValueSymbol(n.parent) : resolved(checker, n);
      if (!s || seen.has(s)) return;
      seen.add(s);
      if (s === identitySym) {
        hit = true;
        return;
      }
      const d = s.valueDeclaration;
      if (depth < 4 && d && ts.isVariableDeclaration(d) && d.initializer) hit = reachesIdentity(d.initializer, seen, depth + 1);
    });
    return hit;
  };
  // P9 (AUDIT-10): an entry covers at most `sites` createTools() calls inside function `fn` of its
  // file, claimed in source order. Any other call in that file (another function, or one more than
  // the entry allows) is UNGUARDED, so a new raw site can't hide behind a file-level allowance.
  const used = new Map<AllowEntry, number>();
  const allowFor = (node: ts.Node, file: string, kind: AllowEntry["kind"]): { entry?: AllowEntry; why?: string } => {
    const inFile = config.allowList.filter((a) => a.kind === kind && norm(join(config.projectDir, a.file)) === norm(file));
    if (inFile.length === 0) return {};
    const fn = enclosingFunctionName(node);
    const entry = inFile.find((a) => a.fn === fn);
    if (!entry) return { why: `not covered by the allow-list (it covers ${inFile.map((a) => a.fn).join(", ")} in this file, not ${fn})` };
    const n = used.get(entry) ?? 0;
    if (n >= entry.sites) return { why: `not covered by the allow-list (it covers ${entry.sites} site(s) in ${fn}; this is one more)` };
    used.set(entry, n + 1);
    return { entry };
  };

  const out: CoverageSite[] = [];
  for (const sf of project.scanned) {
    if (sf === indexSf) continue;
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || resolved(checker, n.expression) !== createToolsSym) return;
      const at = { op: "createTools()", file: display(project, sf.fileName), line: lineOf(n) };
      const arg = n.arguments[0];
      const wrapProp = arg ? checker.getTypeAtLocation(arg).getProperty("wrap") : undefined;
      const optional = !wrapProp || (wrapProp.flags & ts.SymbolFlags.Optional) !== 0;
      if (optional) {
        const { entry, why } = allowFor(n, sf.fileName, "no-wrap");
        out.push(
          entry
            ? { ...at, status: "raw-by-design", detail: entry.reason }
            : { ...at, status: "UNGUARDED", detail: `createTools() without a wrap: every op is raw${why ? `; ${why}` : ""}` },
        );
        return;
      }
      // The wrap expression: the literal property when visible, else the whole argument.
      let wrapExpr: ts.Node = arg!;
      const lit = unwrapExpr(arg!);
      if (ts.isObjectLiteralExpression(lit)) {
        const p = lit.properties.find((x) => x.name && ts.isIdentifier(x.name) && x.name.text === "wrap");
        if (p && ts.isPropertyAssignment(p)) wrapExpr = p.initializer;
        else if (p && ts.isShorthandPropertyAssignment(p)) wrapExpr = p.name;
      }
      const text = wrapExpr === arg ? `(${arg!.getText(sf).slice(0, 40)}…).wrap` : wrapExpr.getText(sf);
      if (reachesIdentity(wrapExpr, new Set(), 0)) {
        const { entry, why } = allowFor(n, sf.fileName, "identity-wrap");
        out.push(
          entry
            ? { ...at, status: "raw-by-design", detail: `wrap: ${text} can be identityWrap; ${entry.reason}` }
            : { ...at, status: "UNGUARDED", detail: `wrap: ${text} can be identityWrap${why ? `; ${why}` : ""}` },
        );
        return;
      }
      out.push({ ...at, status: "guarded", detail: `wrap: ${text}` });
    });
  }
  return out.sort(bySite);
}

function bySite(a: CoverageSite, b: CoverageSite): number {
  return a.op.localeCompare(b.op) || a.file.localeCompare(b.file) || a.line - b.line;
}

// ---------------------------------------------------------------------------------------------
// Output

export function formatCoverage(report: CoverageReport): string {
  const lines: string[] = [];
  lines.push(`notary guards coverage  backend: ${report.backend}`);
  lines.push(`  ${report.backendNote}`);
  if (report.entire) {
    const g = report.entire;
    lines.push(`  ${g.command}`);
    lines.push(`  graph: ${g.provider} ${g.providerVersion}, commit ${g.commit?.slice(0, 12) ?? "?"}${g.worktree ? " + working tree" : ""}, completeness ${g.completeness}, ${g.partialFailures} partial failures`);
  }
  const table = (title: string, rows: CoverageSite[]) => {
    lines.push("", title);
    if (rows.length === 0) {
      lines.push("  (none)");
      return;
    }
    const wOp = Math.max(...rows.map((r) => r.op.length), 2);
    const wSt = Math.max(...rows.map((r) => r.status.length), 6);
    const wAt = Math.max(...rows.map((r) => `${r.file}:${r.line}`.length), 9);
    lines.push(`  ${"OP".padEnd(wOp)}  ${"STATUS".padEnd(wSt)}  ${"CALL SITE".padEnd(wAt)}  DETAIL`);
    for (const r of rows) lines.push(`  ${r.op.padEnd(wOp)}  ${r.status.padEnd(wSt)}  ${`${r.file}:${r.line}`.padEnd(wAt)}  ${r.detail}`);
  };
  const opSites = report.sites.filter((s) => !s.op.startsWith("new "));
  const missing = report.ops.filter((o) => !opSites.some((s) => s.op === o.op));
  table(`Raw client methods (${report.ops.length} public methods from the class declarations)`, opSites);
  for (const o of missing) lines.push(`  ${o.op}: no call site (${o.exposed ? "exposed" : "not in the ops table, unreachable"}; declared ${o.declaredAt})`);
  table("Raw client constructions", report.sites.filter((s) => s.op.startsWith("new ")));
  table("createTools() calls", report.createToolsCalls);
  const t = report.totals;
  lines.push("", `Totals: ${t.sites} sites, ${t.guarded} guarded, ${t.rawByDesign} raw-by-design, ${t.unguarded} UNGUARDED (${t.ops} ops)`);
  lines.push(`unguarded_call_sites = ${report.unguarded_call_sites}`);
  return lines.join("\n");
}
