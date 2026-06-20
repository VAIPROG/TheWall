#!/usr/bin/env bun
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  The Wall Dev — Bot Token Diagnostics (Discord & Telegram)               ║
 * ║                                                                          ║
 * ║  Usage:                                                                  ║
 * ║    bun scripts/test-bot.ts [TOKEN] [TARGET_USER_ID]                      ║
 * ║                                                                          ║
 * ║  Features:                                                               ║
 * ║    - Auto-detects token platform (Discord / Telegram)                    ║
 * ║    - Validates bot identity & API access                                 ║
 * ║    - Tests gateway/webhook operational status                            ║
 * ║    - Validates CDN connectivity & image fetching                         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

/* ═══════════════════════════════════════════════════════════════════════════
 * TUI Engine (TrueColor & Formatting)
 * ═══════════════════════════════════════════════════════════════════════════ */

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";

const FG_GREEN = "\x1b[38;2;74;222;128m";
const FG_YELLOW = "\x1b[38;2;250;204;21m";
const FG_CYAN = "\x1b[38;2;34;211;238m";
const FG_RED = "\x1b[38;2;248;113;113m";
const FG_MAGENTA = "\x1b[38;2;217;70;239m";

const ICON = {
  ok: `${FG_GREEN}✔${RESET}`,
  warn: `${FG_YELLOW}⚠${RESET}`,
  err: `${FG_RED}✖${RESET}`,
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

class Spinner {
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private timer?: ReturnType<typeof setInterval>;
  private i = 0;
  private text = "";
  private isSpinning = false;

  start(text: string) {
    this.text = text;
    this.isSpinning = true;
    process.stdout.write("\x1b[?25l");
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
    process.stdout.write("\x1b[?25h");
  }
}

process.on("SIGINT", () => {
  process.stdout.write("\x1b[?25h\n");
  process.exit(0);
});

function fatal(msg: string): never {
  process.stdout.write("\x1b[?25h\n");
  console.log(`  ${STATUS.err} ${FG_RED}${BOLD}FATAL ERROR:${RESET} ${msg}\n`);
  process.exit(1);
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Parsing & Initialization
 * ═══════════════════════════════════════════════════════════════════════════ */

const args = Bun.argv.slice(2);
let token =
  args[0] || process.env.DISCORD_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
let targetUserId = args[1];

if (!token) {
  console.log(
    `\n  ${STATUS.info} ${BOLD}Usage:${RESET} bun scripts/test-bot.ts <TOKEN> [USER_ID]`,
  );
  console.log(
    `         Or set DISCORD_BOT_TOKEN / TELEGRAM_BOT_TOKEN env var.\n`,
  );
  process.exit(1);
}

const isTelegram = /^[0-9]+:[a-zA-Z0-9_-]+$/.test(token);
const platform = isTelegram ? "Telegram" : "Discord";
const platBadge = isTelegram
  ? badge("TELEGRAM", "36;161;222", "255;255;255") // Telegram Blue
  : badge("DISCORD", "88;101;242", "255;255;255"); // Blurple

console.log(`\n  ${BOLD}${FG_CYAN}╔${"═".repeat(60)}╗${RESET}`);
console.log(
  `  ${BOLD}${FG_CYAN}║${RESET}  ${BOLD}BOT TOKEN DIAGNOSTICS${RESET}${" ".repeat(25)}${platBadge} ${BOLD}${FG_CYAN}║${RESET}`,
);
console.log(`  ${BOLD}${FG_CYAN}╚${"═".repeat(60)}╝${RESET}\n`);

/* ═══════════════════════════════════════════════════════════════════════════
 * Telegram Diagnostics
 * ═══════════════════════════════════════════════════════════════════════════ */

async function testTelegram(token: string) {
  const API = `https://api.telegram.org/bot${token}`;
  const spin = new Spinner();

  // 1. Check Identity
  spin.start("Validating Telegram Bot Identity...");
  let meRes = await fetch(`${API}/getMe`);
  if (!meRes.ok) fatal(`Invalid Token or API down (HTTP ${meRes.status})`);
  let meData = await meRes.json();
  if (!meData.ok) fatal(`Telegram API Error: ${meData.description}`);

  const bot = meData.result;
  spin.stop(ICON.ok, `Identity Verified`);
  console.log(`     ${ICON.tree} Username : @${BOLD}${bot.username}${RESET}`);
  console.log(`     ${ICON.tree} Bot ID   : ${DIM}${bot.id}${RESET}`);
  console.log(
    `     ${ICON.treeEnd} Can Read : ${bot.can_read_all_group_messages ? FG_GREEN + "Yes" : FG_YELLOW + "No"}${RESET}`,
  );

  // 2. Check Webhook Status
  spin.start("Checking Webhook Status...");
  let whRes = await fetch(`${API}/getWebhookInfo`);
  let whData = await whRes.json();
  spin.stop(ICON.ok, `Webhook Status`);
  console.log(
    `     ${ICON.treeEnd} URL      : ${whData.result.url ? FG_CYAN + whData.result.url + RESET : DIM + "(Not configured - Polling mode)" + RESET}`,
  );

  // 3. Test CDN (Get bot avatar)
  spin.start("Fetching Profile Photos (CDN Test)...");
  let photoRes = await fetch(`${API}/getUserProfilePhotos?user_id=${bot.id}`);
  let photoData = await photoRes.json();

  if (photoData.result.total_count === 0) {
    spin.stop(
      ICON.warn,
      `CDN Test Skipped ${DIM}(Bot has no profile picture)${RESET}`,
    );
  } else {
    // Get highest resolution photo file_id
    const fileId = photoData.result.photos[0].pop().file_id;
    let fileRes = await fetch(`${API}/getFile?file_id=${fileId}`);
    let fileData = await fileRes.json();
    const filePath = fileData.result.file_path;

    // Fetch actual file
    const cdnStart = performance.now();
    let imgRes = await fetch(
      `https://api.telegram.org/file/bot${token}/${filePath}`,
    );
    if (!imgRes.ok) fatal(`CDN Fetch Failed (HTTP ${imgRes.status})`);

    let buf = await imgRes.arrayBuffer();
    spin.stop(
      ICON.ok,
      `CDN Connection OK ${DIM}(${(performance.now() - cdnStart).toFixed(0)}ms)${RESET}`,
    );
    console.log(`     ${ICON.tree} File     : ${DIM}${filePath}${RESET}`);
    console.log(
      `     ${ICON.treeEnd} Size     : ${FG_GREEN}${kb(buf.byteLength)}${RESET}`,
    );
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Discord Diagnostics
 * ═══════════════════════════════════════════════════════════════════════════ */

async function testDiscord(token: string, targetId?: string) {
  const API = "https://discord.com/api/v10";
  const headers = { Authorization: `Bot ${token}` };
  const spin = new Spinner();

  // 1. Check Identity
  spin.start("Validating Discord Bot Identity...");
  let meRes = await fetch(`${API}/users/@me`, { headers });
  if (!meRes.ok) fatal(`Invalid Token or API down (HTTP ${meRes.status})`);
  let bot = await meRes.json();

  spin.stop(ICON.ok, `Identity Verified`);
  console.log(
    `     ${ICON.tree} Username : ${BOLD}${bot.username}#${bot.discriminator}${RESET}`,
  );
  console.log(`     ${ICON.tree} Bot ID   : ${DIM}${bot.id}${RESET}`);
  console.log(
    `     ${ICON.treeEnd} 2FA/MFA  : ${bot.mfa_enabled ? FG_GREEN + "Enabled" : FG_YELLOW + "Disabled"}${RESET}`,
  );

  // 2. Check Gateway Limits
  spin.start("Checking Gateway Operational Status...");
  let gwRes = await fetch(`${API}/gateway/bot`, { headers });
  if (!gwRes.ok) fatal(`Gateway Check Failed (HTTP ${gwRes.status})`);
  let gw = await gwRes.json();

  spin.stop(ICON.ok, `Gateway Limits Verified`);
  console.log(`     ${ICON.tree} Shards   : ${gw.shards}`);
  console.log(
    `     ${ICON.treeEnd} Session  : ${FG_GREEN}${gw.session_start_limit.remaining}${RESET}/${gw.session_start_limit.total} remaining`,
  );

  // 3. Target User & CDN Fetch
  const tId = targetId || bot.id;
  spin.start(`Fetching User ${tId}...`);
  let userRes = await fetch(`${API}/users/${tId}`, { headers });
  if (!userRes.ok) fatal(`Failed to fetch user (HTTP ${userRes.status})`);
  let user = await userRes.json();

  spin.stop(ICON.ok, `User Found: ${BOLD}${user.username}${RESET}`);

  // Resolve CDN URL
  let cdnUrl;
  if (user.avatar) {
    const ext = user.avatar.startsWith("a_") ? "gif" : "png";
    cdnUrl = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=256`;
  } else {
    const idx =
      user.discriminator === "0"
        ? (BigInt(user.id) >> 22n) % 6n
        : parseInt(user.discriminator) % 5;
    cdnUrl = `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
  }

  spin.start("Testing Discord CDN Connection...");
  const cdnStart = performance.now();
  let imgRes = await fetch(cdnUrl);
  if (!imgRes.ok) fatal(`CDN Fetch Failed (HTTP ${imgRes.status})`);

  const buf = await imgRes.arrayBuffer();
  const cType = imgRes.headers.get("content-type");

  spin.stop(
    ICON.ok,
    `CDN Connection OK ${DIM}(${(performance.now() - cdnStart).toFixed(0)}ms)${RESET}`,
  );
  console.log(`     ${ICON.tree} Image    : ${DIM}${cType}${RESET}`);
  console.log(
    `     ${ICON.treeEnd} Size     : ${FG_GREEN}${kb(buf.byteLength)}${RESET}`,
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Execution
 * ═══════════════════════════════════════════════════════════════════════════ */

async function main() {
  if (isTelegram) {
    await testTelegram(token!);
  } else {
    await testDiscord(token!, targetUserId);
  }

  console.log(
    `\n  ${STATUS.ok} ${FG_GREEN}${BOLD}ALL DIAGNOSTICS PASSED${RESET}\n`,
  );
}

main().catch((err) => fatal(err.message));
