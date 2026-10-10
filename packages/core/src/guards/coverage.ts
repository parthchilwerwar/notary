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
 *      - `entire` (UNVERIFIED, see ENTIRE_STATUS): `entire graph neighbors --repo <root> --symbol
 *        <Class>.<method> --relation CALLS --direction in --limit 500 --internal-only`, using only
 *        flags documented at https://docs.entire.io/cli-reference/graph (read 2026-10-10). The docs
 *        list no output-format flag for neighbors, so the parser reads either shape it may print.
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
  /** Present only when backend is `entire`: ENTIRE_STATUS (the backend has never run against a real install). */
  unverified?: string;
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
  if (want === "entire" || (want === "auto" && entireAvailable(bin))) {
    try {
      rawRefs = entireRawCallers(config, methods, wiring.opByMethod, bin);
      backend = "entire";
      backendNote = "entire graph neighbors --relation CALLS --direction in per method; wiring and createTools() checks via TypeScript";
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
    ...(backend === "entire" ? { unverified: ENTIRE_STATUS } : {}),
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
 * The `entire` backend is UNVERIFIED: it has never run against a real local Entire install (none on
 * PATH here). Sources, in order of authority for this adapter:
 *   - https://docs.entire.io/cli-reference/graph, read 2026-10-10. Documents `neighbors` with
 *     `--repo`, `--symbol NAME|FILE:LINE`, `--relation TYPE` (default CALLS), `--direction both|in|out`,
 *     `--depth`, `--limit N` (default 20), `--internal-only`, `--head`. It documents NO output-format
 *     flag for neighbors and shows no sample output beyond "Text output begins with
 *     `Index: cache-hit` or `Index: cache-miss`."
 *   - entireio/entire-graph@f22e6c95 (main as of 2026-09-23), internal/cli/neighbors.go: the binary
 *     also accepts `--format json|text|agent` and DEFAULTS to json; text is writeAgentNeighborsFull.
 * So the command uses documented flags only (no `--format`, `--file`, `--line`, `--exclude-tests`),
 * and parseEntireNeighbors accepts both the source's default JSON and the documented text output.
 * Unknown either way: whether its TypeScript resolver links `tools.dodo.x()` on the Pick<> surface
 * to DodoClient.x (a false positive).
 */
export const ENTIRE_STATUS =
  "UNVERIFIED: never run against a real Entire install; command from docs.entire.io/cli-reference/graph (read 2026-10-10), output parsing from those docs plus entire-graph@f22e6c95 source";

export interface EntireCaller {
  caller: string;
  /** As reported (relative to --repo). */
  file: string;
  /** 0 when Entire reported no line (a file-level endpoint without a resolved call site). */
  line: number;
  resolution?: string;
  confidence?: number;
  /** Further call sites of this method inside the same caller that Entire folds into one edge. */
  additionalSites?: number;
}

export interface EntireNeighborsParse {
  /** Which shape stdout was in: `json` (entire-graph's default per source) or `text` (per docs). */
  format: "json" | "text";
  callers: EntireCaller[];
  /** False when the symbol matched nothing, or only fuzzily (Entire then reports other symbols). */
  exactMatch: boolean;
  disambiguationRequired: boolean;
  truncated: boolean;
}

/**
 * Parse `entire graph neighbors --direction in` stdout. JSON when it starts with `{`, else the text
 * output, which must start with the documented `Index: cache-hit|miss` line. Anything else throws.
 */
export function parseEntireNeighbors(stdout: string): EntireNeighborsParse {
  const body = stdout.replace(/^\uFEFF/, "").trimStart();
  if (body.startsWith("{")) return parseEntireNeighborsJson(body);
  if (/^Index: cache-(hit|miss)\b/.test(body)) return parseEntireNeighborsText(body);
  throw new Error(`unrecognized entire graph neighbors output (expected JSON or "Index: cache-…"): ${JSON.stringify(body.slice(0, 80))}`);
}

/** JSON shape per entire-graph@f22e6c95 neighborResponse / neighborFocus / neighborEdge / callSite tags. */
function parseEntireNeighborsJson(body: string): EntireNeighborsParse {
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
    format: "json",
    callers,
    exactMatch: (raw.matches?.length ?? 0) > 0 && raw.fuzzy_match !== true,
    disambiguationRequired: raw.disambiguation_required === true,
    truncated: raw.truncated === true,
  };
}

/**
 * Text shape. Only the first line is documented; the rest follows entire-graph@f22e6c95
 * writeAgentNeighborsFull: `Focus: …`, then `Callers:` with one `- <name> (<file>:<line>[, def :<n>])
 * [annotations]` line per edge (or `- none`), each optionally followed by indented call-context
 * lines; `Callees: …`; `Neighbor lists truncated; …` when --limit cut the list.
 */
function parseEntireNeighborsText(body: string): EntireNeighborsParse {
  const callers: EntireCaller[] = [];
  let focus = 0;
  let inCallers = false;
  let sawCallers = false;
  let fuzzy = false;
  let noMatch = false;
  let disambiguationRequired = false;
  let truncated = false;
  const edgeRe = /^- (.*) \(([^()]*?)(?::(\d+))?(?:, def :\d+)?\)(?: \[([^\]]*)\])?$/;
  const moreRe = /^\+(\d+) more call sites?$/;
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("Focus: ")) {
      focus++;
      inCallers = false;
    } else if (line === "Callers:") {
      inCallers = sawCallers = true;
    } else if (line.startsWith("Callers: not queried")) {
      throw new Error("entire graph neighbors did not query callers (--direction in was not honored)");
    } else if (line.startsWith("No symbols matched ")) {
      noMatch = true;
    } else if (line.startsWith("No exact match for ")) {
      fuzzy = true;
    } else if (/^".*" matches \d+ definitions;/.test(line)) {
      disambiguationRequired = true;
    } else if (line.startsWith("Neighbor lists truncated")) {
      truncated = true;
      inCallers = false;
    } else if (inCallers && line.startsWith("- ")) {
      if (line === "- none") continue;
      const m = edgeRe.exec(line);
      if (!m) throw new Error(`unrecognized entire graph caller line: ${JSON.stringify(line)}`);
      const notes = m[4] ? m[4].split(", ") : [];
      const more = notes.map((n) => moreRe.exec(n)).find((x) => x !== null);
      const resolution = notes.find((n) => n !== "file-level" && !moreRe.test(n) && !/^[A-Z_]+$/.test(n));
      callers.push({
        caller: m[1]!,
        file: m[2]!.split("\\").join("/"),
        line: m[3] ? Number(m[3]) : 0,
        ...(resolution ? { resolution } : {}),
        ...(more ? { additionalSites: Number(more[1]) } : {}),
      });
    } else if (inCallers && line.length > 0 && !line.startsWith(" ")) {
      inCallers = false; // `Callees: …`, `Two-hop path family …`, or anything else unindented
    }
  }
  if (!disambiguationRequired && !noMatch && focus > 0 && !sawCallers) {
    throw new Error("entire graph neighbors text output has a Focus but no Callers section");
  }
  return { format: "text", callers, exactMatch: focus > 0 && !fuzzy && !noMatch, disambiguationRequired, truncated };
}

/** Documented flags only (docs.entire.io/cli-reference/graph, read 2026-10-10); see ENTIRE_STATUS. */
export function entireNeighborsArgs(repo: string, method: { className: string; name: string }): string[] {
  return [
    "graph", "neighbors",
    "--repo", repo,
    "--symbol", `${method.className}.${method.name}`,
    "--relation", "CALLS",
    "--direction", "in",
    "--limit", "500",
    "--internal-only",
  ];
}

function entireRawCallers(config: CoverageConfig, methods: RawMethod[], opByMethod: Map<string, string>, bin: string): CoverageSite[] {
  const scanRoots = config.scanDirs.map((d) => relative(config.displayRoot, join(config.projectDir, d)).split(sep).join("/") + "/");
  const out: CoverageSite[] = [];
  for (const m of methods) {
    const args = entireNeighborsArgs(config.displayRoot, { className: m.client.className, name: m.name });
    const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
    if (r.error || r.status !== 0) throw new Error(`entire ${args.join(" ")} failed: ${r.error?.message ?? r.stderr.trim()}`);
    const parsed = parseEntireNeighbors(r.stdout);
    if (parsed.disambiguationRequired) throw new Error(`entire graph could not resolve ${m.key} to one definition`);
    if (!parsed.exactMatch) throw new Error(`entire graph found no exact definition for ${m.key}`);
    if (parsed.truncated) throw new Error(`entire graph truncated the callers of ${m.key}`);
    const op = opByMethod.get(m.key) ?? `${m.client.opPrefix}.${m.name}`;
    for (const c of parsed.callers) {
      const file = isAbsolute(c.file) ? relative(config.displayRoot, c.file).split(sep).join("/") : c.file;
      // Keeps only scanned dirs, which also drops test/ (`--exclude-tests` is not documented).
      if (!scanRoots.some((r0) => file.startsWith(r0))) continue;
      const notes = [c.resolution, c.confidence === undefined ? undefined : String(c.confidence), c.additionalSites ? `+${c.additionalSites} more in this caller` : undefined]
        .filter(Boolean)
        .join(" ");
      const how = `called from ${c.caller}${notes ? ` [${notes}]` : ""}${c.line === 0 ? " (no line reported)" : ""}`;
      out.push({ op, file, line: c.line, status: "UNGUARDED", detail: `${how} (entire graph, UNVERIFIED backend, ${parsed.format} output)` });
    }
  }
  return out;
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
  if (report.unverified) lines.push(`  UNVERIFIED backend: ${report.unverified}`);
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
