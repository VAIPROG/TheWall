#!/usr/bin/env bun
/**
 * The Wall Dev — test runner.
 *
 * The extension tests are plain assertion scripts (node:assert): each file
 * runs its checks at import and throws on the first failure, so a clean exit
 * means it passed. This runner executes each one in its own Bun process,
 * times it, and prints a tidy report — plus an optional tsc gate and the
 * backend's cargo tests.
 *
 * Usage:
 *   bun scripts/test.ts                 extension tests (+ tsc gate)
 *   bun scripts/test.ts --backend       also run `cargo test`
 *   bun scripts/test.ts --backend-live  also run the #[ignore]d live tests
 *   bun scripts/test.ts --filter tiles  only files whose name contains "tiles"
 *   bun scripts/test.ts --no-typecheck  skip the tsc gate
 */

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extDir = join(root, "tests", "extension");

const args = Bun.argv.slice(2);
const withBackend = args.includes("--backend") || args.includes("--backend-live");
const backendLive = args.includes("--backend-live");
const noTypecheck = args.includes("--no-typecheck");
const filter = (() => {
  const i = args.indexOf("--filter");
  return i >= 0 ? args[i + 1] : null;
})();

const tty = process.stdout.isTTY;
const c = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => c("1", s);
const dim = (s: string) => c("2", s);
const green = (s: string) => c("32", s);
const red = (s: string) => c("31", s);
const cyan = (s: string) => c("36", s);
const yellow = (s: string) => c("33", s);
const OK = green(tty ? "✔" : "PASS");
const NO = red(tty ? "✖" : "FAIL");

function header(title: string) {
  console.log("\n" + bold(cyan(`══ ${title} ` + "═".repeat(Math.max(2, 46 - title.length)))));
}

interface Result {
  name: string;
  ok: boolean;
  ms: number;
  checks: number;
  detail?: string;
}

const results: Result[] = [];

/** Run one assertion-script test file in its own Bun process. */
function runFile(file: string): Result {
  const start = performance.now();
  const proc = Bun.spawnSync(["bun", join(extDir, file)], { stdout: "pipe", stderr: "pipe" });
  const ms = Math.round(performance.now() - start);
  const out = proc.stdout.toString() + proc.stderr.toString();
  const ok = proc.exitCode === 0;
  // Each "... OK" progress line is one checkpoint group; handy as a rough
  // count of what the file exercised.
  const checks = (out.match(/ OK$/gm) || []).length;
  if (ok) {
    console.log(`  ${OK} ${file.padEnd(30)} ${dim(`${ms}ms · ${checks} checks`)}`);
  } else {
    console.log(`  ${NO} ${file.padEnd(30)} ${dim(`${ms}ms`)}`);
    // Surface the failure tail so the reason is visible inline.
    const tail = out.trim().split("\n").slice(-6).join("\n");
    console.log(tail.replace(/^/gm, "      " + dim("│ ")));
  }
  return { name: file, ok, ms, checks, detail: ok ? undefined : out };
}

// ── Typecheck gate ──────────────────────────────────────────────────────────
if (!noTypecheck) {
  header("Typecheck (tsc --noEmit)");
  const start = performance.now();
  const proc = Bun.spawnSync(["bunx", "tsc", "--noEmit"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const ms = Math.round(performance.now() - start);
  if (proc.exitCode === 0) {
    console.log(`  ${OK} types clean ${dim(`(${ms}ms)`)}`);
  } else {
    console.log(`  ${NO} tsc reported errors:`);
    console.log((proc.stdout.toString() + proc.stderr.toString()).trim().replace(/^/gm, "      "));
    process.exit(1);
  }
}

// ── Extension tests ─────────────────────────────────────────────────────────
header("Extension tests");
let files = readdirSync(extDir)
  .filter((f) => f.endsWith(".test.ts"))
  .sort();
if (filter) files = files.filter((f) => f.includes(filter));
if (files.length === 0) {
  console.log(yellow(`  no test files match ${filter ? `"${filter}"` : "*.test.ts"}`));
} else {
  for (const f of files) results.push(runFile(f));
}

// ── Backend tests (optional) ─────────────────────────────────────────────────
let backendOk: boolean | null = null;
if (withBackend) {
  header(backendLive ? "Backend tests (live, --ignored)" : "Backend tests (cargo)");
  const cargoArgs = ["test", "--manifest-path", join(root, "backend", "Cargo.toml")];
  if (backendLive) cargoArgs.push("--", "--ignored");
  const start = performance.now();
  const proc = Bun.spawnSync(["cargo", ...cargoArgs], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const ms = Math.round(performance.now() - start);
  const out = proc.stdout.toString() + proc.stderr.toString();
  backendOk = proc.exitCode === 0;
  if (backendOk) {
    console.log(`  ${OK} cargo test ${dim(`(${(ms / 1000).toFixed(1)}s)`)}`);
  } else {
    console.log(`  ${NO} cargo test`);
    console.log(out.trim().split("\n").slice(-15).join("\n").replace(/^/gm, "      " + dim("│ ")));
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────
header("Summary");
const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
const totalChecks = results.reduce((n, r) => n + r.checks, 0);
const totalMs = results.reduce((n, r) => n + r.ms, 0);
console.log(
  `  Extension: ${green(`${passed} passed`)}${failed ? ", " + red(`${failed} failed`) : ""}` +
    ` ${dim(`· ${totalChecks} checks · ${totalMs}ms`)}`,
);
if (backendOk !== null) {
  console.log(`  Backend:   ${backendOk ? green("passed") : red("failed")}`);
}

const allGreen = failed === 0 && backendOk !== false;
console.log("\n  " + (allGreen ? green(bold("All tests passed.")) : red(bold("Some tests failed."))) + "\n");
process.exit(allGreen ? 0 : 1);
