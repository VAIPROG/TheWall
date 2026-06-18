#!/usr/bin/env bun
/**
 * OpenAPI generator — the route table in backend/src/main.rs is the source
 * of truth.
 *
 * What it does:
 *   1. Parses every `.route("path", method(handler))` registration (multi-line
 *      and chained `get(a).post(b)` forms included).
 *   2. Tags each route with the nearest preceding `// --- section ---` comment.
 *   3. Rebuilds the `paths:` section of spec/openapi.yaml. A path that already
 *      exists in the current yaml keeps its hand-written block VERBATIM;
 *      new paths get a generated stub marked `x-generated: true`; paths that
 *      no longer exist in main.rs are dropped (with a warning).
 *   4. Preserves the existing `components:` tail verbatim, syncs `info.version`
 *      with backend/Cargo.toml, and copies the result to landing/openapi.yaml
 *      (served as /openapi.yaml for Swagger/Redoc on the landing).
 *
 * Run: bun scripts/gen-openapi.ts   (or: bun run openapi)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN_RS = join(root, "backend", "src", "main.rs");
const CARGO = join(root, "backend", "Cargo.toml");
const SPEC = join(root, "spec", "openapi.yaml");
const LANDING = join(root, "landing", "openapi.yaml");

/* ── 1. Parse the axum route table ──────────────────────────────────────── */

interface Route {
  path: string;
  methods: { verb: string; handler: string }[];
  tag: string;
}

const src = readFileSync(MAIN_RS, "utf8");

// Track section comments (`// --- foo ---`) by byte offset so each route can
// pick the closest one above it.
const sections: { at: number; name: string }[] = [];
for (const m of src.matchAll(/\/\/ --+ ?(.+?) ?-+\n/g)) {
  sections.push({ at: m.index!, name: m[1].trim().replace(/-+$/, "").trim() });
}
function sectionFor(at: number): string {
  let best = "misc";
  for (const s of sections) {
    if (s.at < at) best = s.name;
    else break;
  }
  // "auth: site-token login, JWT refresh" → "auth"
  return best.split(":")[0].trim().toLowerCase();
}

const routes: Route[] = [];
// Match the opening of each registration, then walk the chars with a paren
// counter to find its true end — regex alone trips over trailing commas,
// nested calls and comments between registrations.
const openRe = /\.route\(\s*"([^"]+)"\s*,/g;
for (const m of src.matchAll(openRe)) {
  const path = m[1];
  let depth = 1; // we are inside .route(
  let i = m.index! + m[0].length;
  const start = i;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === '"') {
      // skip string literals so parens inside them don't count
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
    }
    i++;
  }
  const handlerExpr = src.slice(start, i - 1);
  const methods: Route["methods"] = [];
  for (const h of handlerExpr.matchAll(
    /\b(get|post|put|delete|patch)\s*\(\s*([A-Za-z0-9_:]+)/g,
  )) {
    methods.push({ verb: h[1], handler: h[2] });
  }
  if (!methods.length) continue; // not a method router (shouldn't happen)
  routes.push({ path, methods, tag: sectionFor(m.index!) });
}

const grepCount = (src.match(/\.route\(/g) || []).length;
if (routes.length !== grepCount) {
  console.warn(
    `⚠ parsed ${routes.length} routes but main.rs has ${grepCount} .route( calls — check the regex`,
  );
}

/* ── 2. Version from Cargo.toml ─────────────────────────────────────────── */

const cargoVersion =
  readFileSync(CARGO, "utf8").match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? "0.0.0";

/* ── 3. Existing yaml: extract per-path blocks + components tail ────────── */

const old = existsSync(SPEC) ? readFileSync(SPEC, "utf8") : "";
const oldPathBlocks = new Map<string, string>();
let componentsTail = "";
{
  const pathsAt = old.indexOf("\npaths:");
  if (pathsAt !== -1) {
    const afterPaths = old.slice(pathsAt + "\npaths:".length + 1);
    // components/webhooks at column 0 terminate the paths section.
    const tailMatch = afterPaths.match(/^(components|webhooks):/m);
    const pathsBody = tailMatch
      ? afterPaths.slice(0, tailMatch.index!)
      : afterPaths;
    componentsTail = tailMatch ? afterPaths.slice(tailMatch.index!) : "";
    // Split into `  /path:` blocks (exactly two-space indent).
    const blockRe = /^ {2}(\/[^\s:]*):\s*$/gm;
    const marks: { at: number; path: string }[] = [];
    for (const b of pathsBody.matchAll(blockRe)) {
      marks.push({ at: b.index!, path: b[1] });
    }
    for (let i = 0; i < marks.length; i++) {
      const end = i + 1 < marks.length ? marks[i + 1].at : pathsBody.length;
      const block = pathsBody.slice(marks[i].at, end).trimEnd();
      // Blocks still carrying the generated marker are NOT hand-written —
      // let them regenerate so stub improvements propagate. Removing the
      // marker (while fleshing a block out) is what makes an edit stick.
      if (block.includes("x-generated: true")) continue;
      oldPathBlocks.set(marks[i].path, block);
    }
  }
}

if (!componentsTail.trim()) {
  componentsTail = `components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
`;
}

/* ── 4. Emit ────────────────────────────────────────────────────────────── */

function stubFor(route: Route): string {
  const params = [...route.path.matchAll(/\{([^}]+)\}/g)].map((p) => p[1]);
  const lines: string[] = [`  ${route.path}:`];
  for (const { verb, handler } of route.methods) {
    const opId = handler.replace(/^routes::/, "").replace(/::/g, "_");
    const summary = `${verb.toUpperCase()} ${route.path} — ${handler.split("::").pop()} (${route.tag})`;
    lines.push(`    ${verb}:`);
    lines.push(`      x-generated: true`);
    lines.push(`      tags: [${JSON.stringify(route.tag)}]`);
    lines.push(`      operationId: ${opId}`);
    lines.push(`      summary: ${JSON.stringify(summary)}`);
    if (params.length) {
      lines.push(`      parameters:`);
      for (const p of params) {
        lines.push(`        - name: ${p}`);
        lines.push(`          in: path`);
        lines.push(`          required: true`);
        lines.push(`          schema: { type: string }`);
      }
    }
    lines.push(`      responses:`);
    lines.push(`        "200": { description: OK }`);
  }
  return lines.join("\n");
}

const seen = new Set<string>();
const pathChunks: string[] = [];
let preserved = 0;
let generated = 0;
for (const r of routes) {
  if (seen.has(r.path)) continue; // axum merges verbs across registrations rarely; first wins
  seen.add(r.path);
  const existing = oldPathBlocks.get(r.path);
  if (existing) {
    pathChunks.push(existing);
    preserved++;
  } else {
    pathChunks.push(stubFor(r));
    generated++;
  }
}

const dropped = [...oldPathBlocks.keys()].filter((p) => !seen.has(p));
if (dropped.length) {
  console.warn(
    `⚠ dropped ${dropped.length} path(s) no longer present in main.rs:\n   ${dropped.join("\n   ")}`,
  );
}

const tags = [...new Set(routes.map((r) => r.tag))];

const header = `# AUTO-GENERATED by scripts/gen-openapi.ts from backend/src/main.rs.
# Hand-edited path blocks are preserved on regeneration (matched by path);
# stubs carry "x-generated: true" — flesh them out and the edit sticks.
openapi: 3.1.0
info:
  title: The Wall Dev — Backend API
  version: ${cargoVersion}
  description: >
    Companion backend for "The Wall Dev" browser extension (filianislost.com).
    Clan chat, template sharing, account links (Telegram/Discord OAuth),
    mailbox, snapshots, protected regions, paint reminders. The extension
    never sends pixel-paint through this backend.
  contact:
    name: VAI_PROG
    url: https://the-wall.vai-rice.space
servers:
  - url: https://the-wall.vai-rice.space
    description: Production
  - url: http://localhost:3080
    description: Local dev

tags:
${tags.map((t) => `  - name: ${JSON.stringify(t)}`).join("\n")}

security:
  - bearerAuth: []

paths:
`;

const out = header + pathChunks.join("\n") + "\n\n" + componentsTail;
writeFileSync(SPEC, out);
writeFileSync(LANDING, out);

console.log(
  `✔ openapi.yaml regenerated: ${routes.length} routes (${seen.size} paths) — ${preserved} preserved, ${generated} stubs, ${dropped.length} dropped`,
);
console.log(`  → ${SPEC}`);
console.log(`  → ${LANDING} (served as /openapi.yaml)`);
