#!/usr/bin/env node
// Secret scan (TDD "Security and safety controls"): fails on key-shaped strings or on any value of
// a secret-looking variable from .env, in git-tracked files (plus staged/untracked, not ignored)
// and everything under packages/core/fixtures. Prints file:line and the pattern or variable NAME,
// never the matched value. Plain Node, no dependencies. Used by .githooks/pre-commit.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BYTES = 5 * 1024 * 1024;

// Built so this file never matches its own patterns.
const PEM = "-".repeat(5) + "BEGIN";
const PATTERNS = [
  { name: "GitHub token (gho_/ghp_/ghs_/ghu_/ghr_)", re: /\bgh[opsur]_[A-Za-z0-9]{20,}/ },
  { name: "sk- secret key", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "AWS access key id", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "Bearer token", re: /Bearer\s+[A-Za-z0-9._~+/=-]{24,}/ },
  { name: "PEM block", re: new RegExp(`${PEM} [A-Z0-9 ]*-----`) },
];

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD)/i;

function envSecrets() {
  const file = join(root, ".env");
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (SECRET_NAME.test(m[1]) && value.length >= 8) out.push({ name: m[1], value });
  }
  return out;
}

function gitFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split("\0").filter(Boolean);
  } catch {
    console.error("check-secrets: git ls-files failed; scanning fixtures only");
    return [];
  }
}

function walk(dir, acc) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(relative(root, full).split(sep).join("/"));
  }
  return acc;
}

const files = new Set([...gitFiles(), ...walk(join(root, "packages", "core", "fixtures"), [])]);
const secrets = envSecrets();
const hits = [];

for (const rel of [...files].sort()) {
  if (rel === ".env") continue; // gitignored; the source of the values, never committed
  const full = join(root, rel);
  let st;
  try {
    st = statSync(full);
  } catch {
    continue; // deleted in the working tree
  }
  if (!st.isFile() || st.size > MAX_BYTES) continue;
  const buf = readFileSync(full);
  if (buf.subarray(0, 8000).includes(0)) continue; // binary
  const lines = buf.toString("utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const p of PATTERNS) if (p.re.test(line)) hits.push(`${rel}:${i + 1}  ${p.name}`);
    for (const s of secrets) if (line.includes(s.value)) hits.push(`${rel}:${i + 1}  value of ${s.name} from .env`);
  });
}

if (hits.length > 0) {
  console.error(`check-secrets: ${hits.length} possible secret(s) found:`);
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`check-secrets: clean (${files.size} files, ${secrets.length} .env secret values checked)`);
