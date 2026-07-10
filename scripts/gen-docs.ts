#!/usr/bin/env bun
/**
 * The Wall Dev — API documentation generator.
 *
 * The OpenAPI spec is authored as a multi-file tree under `openapi/`
 * (openapi.yml + paths/ + components/). Browsers and doc viewers can't resolve
 * `$ref`s across files, so this script bundles the tree into a single
 * `landing/openapi.yaml` (served as `/openapi.yaml`) and builds a standalone,
 * offline-capable ReDoc page.
 *
 * Outputs:
 *   landing/openapi.yaml               — bundled single-file spec (viewers load this)
 *   landing/api-docs/redoc-static.html — self-contained ReDoc build (no CDN)
 *
 * The existing Win95-themed viewers (landing/api-docs/redoc.html and
 * swagger.html) load `/openapi.yaml` at runtime, so refreshing the bundle keeps
 * them current too.
 *
 * Usage:
 *   bun scripts/gen-docs.ts            bundle + build docs
 *   bun scripts/gen-docs.ts --check    validate + bundle only (no HTML build)
 *   bun run docs
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = join(root, "openapi", "openapi.yml");
const BUNDLE = join(root, "landing", "openapi.yaml");
const REDOC_STATIC = join(root, "landing", "api-docs", "redoc-static.html");

const REDOCLY = "@redocly/cli@latest";

const checkOnly = process.argv.includes("--check");

function rel(p: string): string {
  return relative(root, p).replace(/\\/g, "/");
}

/** Run a command, streaming nothing; return {ok, out}. */
function run(cmd: string[]): { ok: boolean; out: string } {
  const proc = Bun.spawnSync(cmd, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const out = (proc.stdout.toString() + proc.stderr.toString()).trim();
  return { ok: proc.exitCode === 0, out };
}

function fail(msg: string, detail?: string): never {
  console.error(`\n  ✗ ${msg}`);
  if (detail) console.error(detail.replace(/^/gm, "    "));
  process.exit(1);
}

function sizeKb(p: string): string {
  return `${(statSync(p).size / 1024).toFixed(1)} KB`;
}

// ---------------------------------------------------------------------------

if (!existsSync(SPEC)) {
  fail(`spec not found: ${rel(SPEC)}`);
}

console.log(`  API docs generator`);
console.log(`  source: ${rel(SPEC)}\n`);

// 1. Lint — advisory only. Spec problems are surfaced but never block doc
//    generation (bundle + build-docs tolerate them), so `bun run docs` always
//    produces output. Fix lint errors separately.
const lint = run(["bunx", REDOCLY, "lint", SPEC, "--format", "stylish"]);
if (lint.ok) {
  console.log(`  ✔ lint passed`);
} else {
  const errs = (lint.out.match(/error/gi) || []).length;
  console.log(`  ⚠ lint reported problems (${errs}) — continuing; run \`bunx ${REDOCLY} lint ${rel(SPEC)}\` for detail`);
}

// 2. Bundle the multi-file tree into the single file the viewers load.
const bundle = run(["bunx", REDOCLY, "bundle", SPEC, "-o", BUNDLE]);
if (!bundle.ok || !existsSync(BUNDLE)) {
  fail("bundle failed", bundle.out);
}
console.log(`  ✔ bundled → ${rel(BUNDLE)} (${sizeKb(BUNDLE)})`);

// 3. Build a standalone ReDoc page (offline, no CDN dependency).
if (!checkOnly) {
  const docs = run(["bunx", REDOCLY, "build-docs", SPEC, "-o", REDOC_STATIC]);
  if (!docs.ok || !existsSync(REDOC_STATIC)) {
    fail("build-docs failed", docs.out);
  }
  console.log(`  ✔ redoc  → ${rel(REDOC_STATIC)} (${sizeKb(REDOC_STATIC)})`);
}

console.log(`\n  Done. Viewers:`);
console.log(`    /api-docs/swagger.html      (Swagger UI, loads /openapi.yaml)`);
console.log(`    /api-docs/redoc.html        (themed ReDoc, loads /openapi.yaml)`);
if (!checkOnly) {
  console.log(`    /api-docs/redoc-static.html (standalone, offline)`);
}
