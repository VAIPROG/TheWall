#!/usr/bin/env bun
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  The Wall Dev — Next-Gen TUI Build Script                                ║
 * ║                                                                          ║
 * ║  Modes:                                                                  ║
 * ║    (default)    DEV       — sourcemaps, no minify, watch support         ║
 * ║    --release    RELEASE   — whitespace/syntax minify, console stripped   ║
 * ║    --smallest   SMALLEST  — full minify + identifier mangling            ║
 * ║    --publish    PUBLISH   — RELEASE + SMALLEST in one pass, zip outputs  ║
 * ║                                                                          ║
 * ║  Flags:                                                                  ║
 * ║    --watch         (dev only) rebuild on src/ changes, no zips           ║
 * ║    --no-typecheck  skip the tsc gate in release/smallest/publish         ║
 * ║    --no-zip        skip archive packing                                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { build, context as esbuildContext } from "esbuild";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  cpSync,
  existsSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

/* ═══════════════════════════════════════════════════════════════════════════
 * TUI Engine (TrueColor / 256-Color & Formatting)
 * ═══════════════════════════════════════════════════════════════════════════ */

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";

const FG_GREEN = "\x1b[38;2;74;222;128m"; // #4ade80
const FG_YELLOW = "\x1b[38;2;250;204;21m"; // #facc15
const FG_CYAN = "\x1b[38;2;34;211;238m"; // #22d3ee
const FG_RED = "\x1b[38;2;248;113;113m"; // #f87171
const FG_MAGENTA = "\x1b[38;2;217;70;239m"; // #d946ef
const FG_WHITE = "\x1b[38;2;255;255;255m"; // #ffffff

const ICON = {
  ok: `${FG_GREEN}✔${RESET}`,
  warn: `${FG_YELLOW}⚠${RESET}`,
  err: `${FG_RED}✖${RESET}`,
  info: `${FG_CYAN}ℹ${RESET}`,
  tree: `${DIM}├──${RESET}`,
  treeEnd: `${DIM}└──${RESET}`,
};

function badge(label: string, bgRgb: string, fgRgb: string): string {
  return `\x1b[48;2;${bgRgb};38;2;${fgRgb};1m ${label.padStart(label.length + 1).padEnd(label.length + 2)} ${RESET}`;
}

const STATUS = {
  ok: badge("OK", "34;197;94", "0;0;0"),
  warn: badge("WARN", "234;179;8", "0;0;0"),
  err: badge("FAIL", "239;68;68", "255;255;255"),
  info: badge("INFO", "56;189;248", "0;0;0"),
};

/* --- Async Spinner --- */
class Spinner {
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private timer?: ReturnType<typeof setInterval>;
  private i = 0;
  private text = "";
  private isSpinning = false;

  start(text: string) {
    this.text = text;
    this.isSpinning = true;
    process.stdout.write("\x1b[?25l"); // Hide cursor
    this.timer = setInterval(() => {
      process.stdout.write(
        `\x1b[2K\r  ${FG_CYAN}${this.frames[this.i]}${RESET} ${this.text}`,
      );
      this.i = (this.i + 1) % this.frames.length;
    }, 80);
  }

  stop(icon: string, finalMessage: string) {
    if (!this.isSpinning) return;
    clearInterval(this.timer);
    this.isSpinning = false;
    process.stdout.write(`\x1b[2K\r  ${icon} ${finalMessage}\n`);
    process.stdout.write("\x1b[?25h"); // Show cursor
  }
}

process.on("SIGINT", () => {
  process.stdout.write("\x1b[?25h\n");
  process.exit(0);
});

let stepNo = 0;
function printHeader(title: string) {
  stepNo++;
  const t = `${stepNo}. ${title}`;
  console.log(
    `\n  ${BOLD}${FG_CYAN}═ ${t} ${"═".repeat(Math.max(2, 58 - t.length))}${RESET}`,
  );
}

function fatal(msg: string): never {
  process.stdout.write("\x1b[?25h");
  console.log(
    `\n  ${STATUS.err} ${FG_RED}${BOLD}FATAL ERROR:${RESET} ${msg}\n`,
  );
  process.exit(1);
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function fileBytes(path: string): number {
  return existsSync(path) ? readFileSync(path).byteLength : 0;
}

function gzipKB(data: string | Uint8Array): string {
  const buf =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : new Uint8Array(data);
  return kb(Bun.gzipSync(buf).byteLength);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * CLI Args & Mode Configuration
 * ═══════════════════════════════════════════════════════════════════════════ */

type ModeKey = "dev" | "release" | "smallest";

interface Mode {
  key: ModeKey;
  name: string;
  badge: string;
  suffix: string;
  userscript: string;
}

const args = Bun.argv.slice(2);
const isPublish = args.includes("--publish");
const isWatch = args.includes("--watch");
const noTypecheck = args.includes("--no-typecheck");
const noZip = args.includes("--no-zip");

const MODES: Record<ModeKey, Mode> = {
  dev: {
    key: "dev",
    name: "DEVELOPMENT",
    badge: badge("DEVELOPMENT", "192;132;252", "0;0;0"), // Purple bg, Black text
    suffix: "",
    userscript: "the-wall-dev.user.js",
  },
  release: {
    key: "release",
    name: "RELEASE",
    badge: badge("RELEASE", "74;222;128", "0;0;0"), // Green bg, Black text
    suffix: "-release",
    userscript: "the-wall-dev.user.js",
  },
  smallest: {
    key: "smallest",
    name: "SMALLEST",
    badge: badge("SMALLEST", "56;189;248", "0;0;0"), // Blue bg, Black text
    suffix: "-smallest",
    userscript: "the-wall-dev.min.user.js",
  },
};

const variants: Mode[] = isPublish
  ? [MODES.release, MODES.smallest]
  : args.includes("--smallest")
    ? [MODES.smallest]
    : args.includes("--release")
      ? [MODES.release]
      : [MODES.dev];

const isDevRun = variants[0].key === "dev";
const canonical = variants[0];
const headBadge = isPublish
  ? badge("PUBLISH", "239;68;68", "255;255;255")
  : canonical.badge;

/* ═══════════════════════════════════════════════════════════════════════════
 * Initialization
 * ═══════════════════════════════════════════════════════════════════════════ */

const t0 = performance.now();
const root = dirname(fileURLToPath(import.meta.url));
const extDir = join(root, "extension");
const dist = join(root, "dist");

if (!existsSync(join(extDir, "manifest.json"))) {
  fatal(`Extension manifest not found: ${join(extDir, "manifest.json")}`);
}

const manifest = JSON.parse(
  readFileSync(join(extDir, "manifest.json"), "utf8"),
);
const VERSION: string = manifest.version;

const BOX_W = 60;
console.log(`\n  ${BOLD}${FG_CYAN}╔${"═".repeat(BOX_W)}╗${RESET}`);
const titleStr = `${BOLD}THE WALL DEV${RESET} ${DIM}v${VERSION}${RESET}`;
const titleVisibleLen = 12 + 2 + VERSION.length;
const spaces = Math.max(1, BOX_W - titleVisibleLen - 14);
console.log(
  `  ${BOLD}${FG_CYAN}║${RESET}  ${titleStr}${" ".repeat(spaces)}${headBadge}  ${BOLD}${FG_CYAN}║${RESET}`,
);
console.log(`  ${BOLD}${FG_CYAN}╚${"═".repeat(BOX_W)}╝${RESET}`);

interface BrowserTarget {
  name: string;
  slug: string;
  patch?: (m: any) => void;
  hint: string;
}

const browsers: BrowserTarget[] = [
  { name: "Chrome", slug: "chrome", hint: "Dev mode → Load unpacked" },
  {
    name: "Firefox",
    slug: "firefox",
    patch: (m) => {
      m.background = { scripts: ["background.js"] };
      m.browser_specific_settings = {
        gecko: {
          id: "the-wall-dev@vai-rice.space",
          strict_min_version: "128.0",
        },
      };
    },
    hint: "about:debugging → Load Temporary Add-on",
  },
  {
    name: "Safari",
    slug: "safari",
    hint: "Use xcrun safari-web-extension-converter",
  },
];

interface VariantResult {
  mode: Mode;
  hash: string;
  coreBytes: number;
  coreGzip: string;
  userscriptFile: string;
  userscriptBytes: number;
  zips: Record<string, { file: string; bytes: number } | null>;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Pipeline Execution
 * ═══════════════════════════════════════════════════════════════════════════ */

await main();

async function main() {
  /* -- Typecheck gate -- */
  if (!isDevRun && !noTypecheck) {
    printHeader("Types (tsc --noEmit)");
    const tcStart = performance.now();
    const spin = new Spinner();
    spin.start("Checking TypeScript syntax...");

    const proc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });

    await proc.exited;
    if (proc.exitCode !== 0) {
      spin.stop(ICON.err, "Type check failed!");
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      console.log(stdout + stderr);
      fatal(
        "tsc found type errors — production build stopped (use --no-typecheck to skip)",
      );
    }

    spin.stop(
      ICON.ok,
      `Types OK ${DIM}(${(performance.now() - tcStart).toFixed(0)}ms)${RESET}`,
    );
  }

  /* -- Build Variants -- */
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });

  const results: VariantResult[] = [];
  for (let i = 0; i < variants.length; i++) {
    results.push(await buildVariant(variants[i], i + 1, variants.length));
  }

  /* -- Canonical Aliases -- */
  const canonicalResult = results[0];
  if (canonical.suffix !== "") {
    printHeader("Canonical aliases (backward compatibility)");
    const aliases: Array<[string, string]> = [
      [`wall-core${canonical.suffix}.js`, "wall-core.js"],
    ];
    if (canonical.userscript !== "the-wall-dev.user.js") {
      aliases.push([canonical.userscript, "the-wall-dev.user.js"]);
    }
    for (const b of browsers) {
      if (canonicalResult.zips[b.slug]) {
        aliases.push([
          `extension-${b.slug}${canonical.suffix}.zip`,
          `extension-${b.slug}.zip`,
        ]);
      }
    }
    for (const [from, to] of aliases) {
      cpSync(join(dist, from), join(dist, to));
      console.log(
        `  ${ICON.tree} ${DIM}${from} →${RESET} ${BOLD}${to}${RESET}`,
      );
    }
    console.log(
      `  ${STATUS.ok} Canonical set to variant ${BOLD}${canonical.name}${RESET}`,
    );
  }

  /* -- Signature.json -- */
  printHeader("Build metadata (signature.json)");
  const variantMeta = Object.fromEntries(
    results.map((r) => [
      r.mode.key,
      {
        hash: r.hash,
        core_kb: +(r.coreBytes / 1024).toFixed(1),
        core_gzip: r.coreGzip,
        userscript: `/dist/${r.userscriptFile}`,
        userscript_kb: +(r.userscriptBytes / 1024).toFixed(1),
        zips: Object.fromEntries(
          browsers.map((b) => [
            b.slug,
            r.zips[b.slug]
              ? {
                  url: `/dist/${r.zips[b.slug]!.file}`,
                  kb: +(r.zips[b.slug]!.bytes / 1024).toFixed(1),
                }
              : null,
          ]),
        ),
      },
    ]),
  );

  const signature = {
    version: VERSION,
    mode: isPublish ? "PUBLISH" : canonical.name,
    hash: canonicalResult.hash,
    built_at: new Date().toISOString(),
    downloads: {
      userscript: "/dist/the-wall-dev.user.js",
      chrome_zip: "/dist/extension-chrome.zip",
      firefox_zip: "/dist/extension-firefox.zip",
      safari_zip: "/dist/extension-safari.zip",
    },
    variants: variantMeta,
    environment: {
      bun_version: Bun.version,
      platform: process.platform,
    },
  };

  const sigPath = join(dist, "signature.json");
  writeFileSync(sigPath, JSON.stringify(signature, null, 2));
  console.log(
    `  ${STATUS.ok} Written: ${BOLD}signature.json${RESET} (${kb(fileBytes(sigPath))})`,
  );

  /* -- Summary -- */
  printHeader("Summary");
  console.log(
    `  ${DIM}${"MODE".padEnd(12)}  ${"CORE".padEnd(8)}  ${"GZIP".padEnd(9)}  ${"SCRIPT".padEnd(8)}  HASH${RESET}`,
  );

  for (const r of results) {
    console.log(
      `  ${BOLD}${r.mode.name.padEnd(12)}${RESET}` +
        `  ${FG_GREEN}${kb(r.coreBytes).padEnd(8)}${RESET}` +
        `  ${DIM}${r.coreGzip.padEnd(9)}${RESET}` +
        `  ${FG_GREEN}${kb(r.userscriptBytes).padEnd(8)}${RESET}` +
        `  ${DIM}sha256:${r.hash}${RESET}`,
    );
  }

  if (results.length === 2) {
    const saved = results[0].coreBytes - results[1].coreBytes;
    console.log(
      `\n  ${STATUS.info} SMALLEST saves ${FG_GREEN}${kb(saved)}${RESET} over RELEASE (${((saved / results[0].coreBytes) * 100).toFixed(1)}%)`,
    );
  }

  const totalMs = (performance.now() - t0).toFixed(0);
  console.log(`\n  ${BOLD}${FG_CYAN}╚${"═".repeat(BOX_W)}╝${RESET}`);
  console.log(
    `  ${STATUS.ok}  ${FG_GREEN}${BOLD}PIPELINE COMPLETE${RESET}  ${DIM}⏱ Total time: ${BOLD}${totalMs}ms${RESET}`,
  );
  console.log(`  ${BOLD}${FG_CYAN}═${"═".repeat(BOX_W)}═${RESET}\n`);

  /* -- Watch Mode -- */
  if (isWatch) {
    printHeader("Watch mode (esbuild context)");
    const corePath = join(dist, "wall-core.js");
    const refresh = () => {
      const core = readFileSync(corePath, "utf8");
      writeFileSync(
        join(dist, MODES.dev.userscript),
        userscriptHeaderFor(MODES.dev) + "\n" + core,
      );
      for (const b of browsers) {
        const dir = join(dist, `extension-${b.slug}`);
        scaffoldExtension(MODES.dev, dir, core);
        const m = structuredClone(manifest);
        m.name = "The Wall Dev [DEV]";
        b.patch?.(m);
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2));
      }
      console.log(
        `  ${ICON.ok} ${new Date().toLocaleTimeString()} — Hot Rebuild (${kb(fileBytes(corePath))})`,
      );
    };

    const ctx = await esbuildContext({
      ...esbuildOptionsFor(MODES.dev, corePath),
      plugins: [
        {
          name: "walldev-watch",
          setup(buildConfig) {
            buildConfig.onEnd((res) => {
              if (res.errors.length) {
                console.log(
                  `  ${STATUS.err} ${FG_RED}build errors — waiting for fixes${RESET}`,
                );
                return;
              }
              refresh();
            });
          },
        },
      ],
    });

    await ctx.watch();
    console.log(
      `  ${STATUS.info} Watching ${BOLD}src/${RESET} — Ctrl+C to quit. (No zips in watch mode)`,
    );
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Build Primitives
 * ═══════════════════════════════════════════════════════════════════════════ */

function esbuildOptionsFor(mode: Mode, outfile: string) {
  const isDev = mode.key === "dev";
  const isRelease = mode.key !== "dev";
  const isSmallest = mode.key === "smallest";
  return {
    entryPoints: [join(root, "src", "index.ts")],
    bundle: true,
    format: "iife",
    target: "es2022",
    outfile,
    sourcemap: isDev,
    minify: isSmallest,
    minifyWhitespace: isRelease,
    minifySyntax: isRelease,
    minifyIdentifiers: isSmallest,
    legalComments: isRelease ? "none" : "inline",
    drop: isRelease ? ["console", "debugger"] : [],
    define: {
      __INJECT_DEV__: isDev ? "true" : "false",
      __INJECT_VERSION__: JSON.stringify(VERSION),
    },
  } satisfies Parameters<typeof build>[0];
}

function userscriptHeaderFor(mode: Mode): string {
  return `\
// ==UserScript==
// @name         The Wall Dev${mode.key === "dev" ? " [DEV]" : mode.key === "smallest" ? " (min)" : ""}
// @namespace    https://the-wall.vai-rice.space
// @version      ${VERSION}
// @description  Win95 overlay, pixel-scale, drawing assists, Discord/clan sync. Build: ${mode.name}.
// @author       VAI_PROG (vai on wall)
// @match        https://filianislost.com/*
// @icon         https://filianislost.com/static/favicon.png
// @run-at       document-start
// @grant        none
// ==/UserScript==
`;
}

function scaffoldExtension(mode: Mode, targetDir: string, core: string) {
  mkdirSync(targetDir, { recursive: true });
  for (const f of ["background.js", "bridge.js"]) {
    const src = join(extDir, f);
    if (existsSync(src)) cpSync(src, join(targetDir, f));
  }
  const iconSrc = join(extDir, "icons");
  if (existsSync(iconSrc))
    cpSync(iconSrc, join(targetDir, "icons"), { recursive: true });
  writeFileSync(join(targetDir, "wall-core.js"), core);
}

/**
 * Cross-platform directory compression logic.
 * Automatically detects OS and falls back gracefully.
 */
async function makeZip(srcDir: string, outZip: string): Promise<boolean> {
  rmSync(outZip, { force: true });
  const isWin = process.platform === "win32";

  const strategies: Array<{ cmd: string[]; cwd?: string }> = [];

  if (isWin) {
    // Strategy 1: Windows 10+ built-in tar (fastest on Windows)
    strategies.push({
      cmd: ["tar.exe", "-a", "-c", "-f", outZip, "."],
      cwd: srcDir,
    });
    // Strategy 2: PowerShell Compress-Archive (reliable fallback)
    strategies.push({
      cmd: [
        "powershell",
        "-NoProfile",
        "-Command",
        `Compress-Archive -Path "${srcDir}\\*" -DestinationPath "${outZip}" -CompressionLevel Optimal -Force`,
      ],
    });
  } else {
    // Strategy 1: Unix Standard Zip (Linux / macOS)
    strategies.push({
      cmd: ["zip", "-9", "-r", "-q", outZip, "."],
      cwd: srcDir,
    });
  }

  // Universal Fallback: 7-Zip if available in PATH
  strategies.push({ cmd: ["7z", "a", "-tzip", outZip, "."], cwd: srcDir });

  for (const { cmd, cwd } of strategies) {
    try {
      const proc = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "ignore" });
      await proc.exited;
      if (proc.exitCode === 0 && existsSync(outZip)) return true;
    } catch {
      // Ignored. Move to the next archiver in the priority list.
    }
  }
  return false;
}

async function buildVariant(
  mode: Mode,
  idx: number,
  total: number,
): Promise<VariantResult> {
  printHeader(`Variant ${idx}/${total}: ${mode.name}`);
  console.log(
    `  ${mode.badge}   ${DIM}suffix:${RESET} ${mode.suffix || "(none)"}`,
  );

  /* -- core -- */
  const bundleStart = performance.now();
  const corePath = join(dist, `wall-core${mode.suffix}.js`);

  const spin = new Spinner();
  spin.start("Bundling core with esbuild...");

  try {
    await build(esbuildOptionsFor(mode, corePath));
  } catch (err: any) {
    spin.stop(ICON.err, "esbuild failed");
    fatal(`esbuild error:\n${JSON.stringify(err.errors || err, null, 2)}`);
  }

  const core = readFileSync(corePath, "utf8");
  const hash = createHash("sha256").update(core).digest("hex").slice(0, 8);
  const coreBytes = fileBytes(corePath);
  const coreGzip = gzipKB(core);

  spin.stop(
    ICON.ok,
    `Core bundled ${DIM}(${(performance.now() - bundleStart).toFixed(0)}ms)${RESET}`,
  );
  console.log(
    `     ${ICON.tree} File: ${BOLD}${basename(corePath)}${RESET} (${FG_GREEN}${kb(coreBytes)}${RESET} ${DIM}/ gzip ${coreGzip}${RESET})`,
  );
  console.log(`     ${ICON.treeEnd} Hash: ${DIM}sha256:${hash}${RESET}`);

  /* -- userscript -- */
  const userscriptPath = join(dist, mode.userscript);
  writeFileSync(userscriptPath, userscriptHeaderFor(mode) + "\n" + core);
  console.log(
    `  ${STATUS.ok} Userscript: ${FG_MAGENTA}${mode.userscript}${RESET} (${FG_GREEN}${kb(fileBytes(userscriptPath))}${RESET})`,
  );

  /* -- unpacked extensions -- */
  for (let i = 0; i < browsers.length; i++) {
    const b = browsers[i];
    const dir = join(dist, `extension-${b.slug}${mode.suffix}`);
    scaffoldExtension(mode, dir, core);
    const m = structuredClone(manifest);
    m.name = mode.key === "dev" ? "The Wall Dev [DEV]" : "The Wall Dev";
    b.patch?.(m);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2));
    const isLast = i === browsers.length - 1;
    console.log(
      `     ${isLast ? ICON.treeEnd : ICON.tree} ${BOLD}${b.name.padEnd(8)}${RESET} ${DIM}→${RESET} ${basename(dir)}/  ${DIM}${ITALIC}(${b.hint})${RESET}`,
    );
  }

  /* -- zips -- */
  const zips: VariantResult["zips"] = {};
  if (!noZip) {
    for (const b of browsers) {
      const dir = join(dist, `extension-${b.slug}${mode.suffix}`);
      const zipPath = `${dir}.zip`;

      spin.start(`Compressing ${b.name}...`);
      const ok = await makeZip(dir, zipPath);

      if (ok) {
        zips[b.slug] = { file: basename(zipPath), bytes: fileBytes(zipPath) };
        spin.stop(
          ICON.ok,
          `Zipped ${BOLD}${b.name.padEnd(7)}${RESET} → ${FG_MAGENTA}${basename(zipPath)}${RESET} (${FG_GREEN}${kb(zips[b.slug]!.bytes)}${RESET})`,
        );
      } else {
        zips[b.slug] = null;
        spin.stop(
          ICON.warn,
          `${FG_YELLOW}${b.name}${RESET} — ${DIM}zip skipped (no archiver found)${RESET}`,
        );
      }
    }
  } else {
    console.log(`  ${DIM}Archiving skipped (--no-zip).${RESET}`);
  }

  return {
    mode,
    hash,
    coreBytes,
    coreGzip,
    userscriptFile: mode.userscript,
    userscriptBytes: fileBytes(userscriptPath),
    zips,
  };
}
