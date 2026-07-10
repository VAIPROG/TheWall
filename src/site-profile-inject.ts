/**
 * When the host site opens its own user-profile modal (the `.settings-modal`
 * shown when clicking another player's cursor), we attach a small "Wall Dev"
 * section that mirrors the same info we'd render in our own modal: bio,
 * social links, pinned templates, achievement count.
 *
 * We never touch the site's existing markup — we append a new <section>
 * inside the modal body. If our backend has nothing on the user we hide the
 * section so the modal looks identical to what the site shipped.
 *
 * No site code is modified: this is purely DOM mutation from a content
 * script, in the same vein as our chat-emote rendering.
 */
import { getActiveClient } from "./backend/index";
import { esc } from "./helpers";
import { replaceEmotes } from "./emoji";
import { isWalldevDark } from "./theme";
import { log } from "./log";
import { t, pluralize } from "./i18n";
import { triggerFoundTheDev } from "./achievements";

const SECTION_ID = "wd-profile-section";
const MODAL_SEL = ".settings-modal.modal-content";

// Public-profile reads still use the V2 user surface; resolve against the API
// root, not the V3 base. TODO(phase3): adopt /api/v3/users/{ref}.
function piReq<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const client = getActiveClient();
  if (!client) return Promise.reject(new Error("backend offline"));
  return client.req<T>({ method, path, body, root: true });
}
function piRoot(): string {
  return getActiveClient()?.rootUrl ?? "";
}

let observer: MutationObserver | null = null;
/** Username (lowercased) -> resolved profile or `null` if confirmed missing. */
const profileCache = new Map<string, any | null>();

function injectCss(): void {
  if (document.getElementById("wd-profile-inject-css")) return;
  const style = document.createElement("style");
  style.id = "wd-profile-inject-css";
  style.textContent = `
  /* ===== Wall Dev | Profile divider — shown inside the site's settings-modal ===== */
  #${SECTION_ID} {
    margin:10px 0 4px;
    padding:0;
    font-family:"MS Sans Serif",Tahoma,Arial,sans-serif;
    font-size:11px;
    color:#000;
  }
  #${SECTION_ID}.wd-dark { color:#eee; }
  #${SECTION_ID} .wd-divider {
    display:flex; align-items:center; gap:8px;
    margin:6px 0 8px;
    font-weight:bold; color:#0066cc;
    font-size:11px; letter-spacing:1px;
  }
  #${SECTION_ID}.wd-dark .wd-divider { color:#7aa6ff }
  #${SECTION_ID} .wd-divider::before,
  #${SECTION_ID} .wd-divider::after {
    content:""; flex:1; height:0;
    border-top:1px solid rgba(0,0,128,.35);
  }
  #${SECTION_ID}.wd-dark .wd-divider::before,
  #${SECTION_ID}.wd-dark .wd-divider::after {
    border-top-color:rgba(122,166,255,.45);
  }
  #${SECTION_ID} .wd-divider .wd-divider-chip {
    display:inline-flex; align-items:center; gap:5px;
    padding:3px 9px;
    background:#0066cc; color:#fff;
    border-radius:3px;
    font-size:10px; font-weight:bold;
  }
  #${SECTION_ID}.wd-dark .wd-divider .wd-divider-chip { background:#3a82e6 }
  #${SECTION_ID} .wd-divider .wd-divider-chip-dot {
    width:6px; height:6px; border-radius:50%;
    background:#fff; box-shadow:0 0 4px #fff;
  }
  #${SECTION_ID} .wd-body {
    padding:8px 10px;
    background:rgba(0,0,128,.06);
    border:1px solid rgba(0,0,128,.18);
    border-radius:4px;
  }
  #${SECTION_ID}.wd-dark .wd-body {
    background:rgba(40,137,255,.10);
    border-color:rgba(40,137,255,.32);
  }
  #${SECTION_ID} .wd-row { display:flex; justify-content:space-between; align-items:center; font-size:10px; color:#666; }
  #${SECTION_ID}.wd-dark .wd-row { color:#aaa }
  /* Avatar + name header */
  #${SECTION_ID} .wd-head {
    display:flex; gap:10px; align-items:flex-start;
    margin-bottom:6px;
  }
  #${SECTION_ID} .wd-avatar {
    width:48px; height:48px; flex:none;
    border:2px solid #ccc; border-radius:4px;
    object-fit:cover;
    background:#dfdfdf;
    image-rendering:pixelated;
  }
  #${SECTION_ID}.wd-dark .wd-avatar { border-color:#444; background:#1a1a1a }
  #${SECTION_ID} .wd-head-text { flex:1; min-width:0 }
  #${SECTION_ID} .wd-name {
    font-weight:bold; font-size:13px; color:#0066cc;
    line-height:1.2; margin-bottom:2px;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  #${SECTION_ID}.wd-dark .wd-name { color:#7aa6ff }
  #${SECTION_ID} .wd-meta { font-size:10px; color:#666; line-height:1.4 }
  #${SECTION_ID}.wd-dark .wd-meta { color:#aaa }
  #${SECTION_ID} .wd-bio-fallback {
    color:#888 !important;
    font-style:italic;
  }
  /* VAI easter egg — "Just a Dev" badge */
  #${SECTION_ID} .wd-vai-badge {
    display:inline-block;
    padding:2px 7px;
    margin-left:6px;
    background:linear-gradient(90deg,#7a3eb0,#d04ec0);
    color:#fff;
    border-radius:3px;
    font-size:10px;
    font-weight:bold;
    text-transform:uppercase;
    letter-spacing:.5px;
    vertical-align:middle;
    box-shadow:0 1px 2px rgba(0,0,0,.3);
  }
  #${SECTION_ID} .wd-vai-note {
    margin-top:4px; padding:4px 8px;
    background:linear-gradient(90deg,rgba(122,62,176,.12),rgba(208,78,192,.12));
    border-left:3px solid #7a3eb0;
    font-size:11px; font-style:italic;
    color:#7a3eb0;
  }
  #${SECTION_ID}.wd-dark .wd-vai-note { color:#d4a3ff; background:linear-gradient(90deg,rgba(122,62,176,.22),rgba(208,78,192,.22)) }
  #${SECTION_ID} .wd-bio {
    background:#fff; color:#000;
    padding:5px 8px; margin:6px 0;
    border-left:3px solid #0066cc;
    font-size:11px; line-height:1.4;
  }
  #${SECTION_ID}.wd-dark .wd-bio { background:#1a1a1a; color:#eee; border-left-color:#3a82e6 }
  #${SECTION_ID} .wd-links { display:flex; flex-wrap:wrap; gap:4px; margin:4px 0 }
  #${SECTION_ID} .wd-links a {
    display:inline-block; padding:2px 8px;
    background:#fff; color:#0066cc;
    border:1px solid #ccc; border-radius:2px;
    text-decoration:none; font-size:10px;
  }
  #${SECTION_ID}.wd-dark .wd-links a { background:#1a1a1a; color:#7aa6ff; border-color:#444 }
  #${SECTION_ID} .wd-pins { display:flex; gap:3px; margin-top:6px; flex-wrap:wrap }
  #${SECTION_ID} .wd-pins .wd-pin {
    width:40px; height:40px;
    background-size:cover; background-position:center;
    border:1px solid #ccc; image-rendering:pixelated;
    cursor:pointer;
  }
  #${SECTION_ID}.wd-dark .wd-pins .wd-pin { border-color:#444 }
  #${SECTION_ID} .wd-empty {
    padding:6px 0;
    color:#888; font-style:italic; font-size:11px;
    text-align:center;
  }
  #${SECTION_ID}.wd-dark .wd-empty { color:#888 }
  #${SECTION_ID} .wd-empty a { color:#0066cc; text-decoration:none }
  #${SECTION_ID}.wd-dark .wd-empty a { color:#7aa6ff }
  #${SECTION_ID} .wd-section-title {
    font-weight:bold; font-size:10px;
    margin:8px 0 2px; color:#444;
    text-transform:uppercase; letter-spacing:.5px;
  }
  #${SECTION_ID}.wd-dark .wd-section-title { color:#aaa }
  `;
  document.head.appendChild(style);
}

/**
 * Read the displayed username out of the modal. The site renders things like
 *   <span class="name-container"><b>[TKD] </b>piguboy</span>
 * so we strip leading [TAG] noise and return the plain login.
 */
function extractUsername(modal: Element): string | null {
  const span = modal.querySelector(".name-container");
  if (!span) return null;
  // Use textContent and trim a [tag] prefix if present.
  const raw = (span.textContent || "").trim();
  // Remove leading [ANY] tag(s).
  const stripped = raw.replace(/^(\s*\[[^\]]*\]\s*)+/, "").trim();
  return stripped || null;
}

async function fetchProfileByUsername(
  username: string,
): Promise<{ profile: any; achievementCount: number } | null> {
  const key = username.toLowerCase();
  if (profileCache.has(key)) {
    const cached = profileCache.get(key);
    return cached ? { profile: cached, achievementCount: cached.__achCount ?? 0 } : null;
  }
  let profile: any;
  try {
    profile = await piReq(
      "GET",
      `/v2/users/by-username/${encodeURIComponent(username)}`,
    );
  } catch (e: any) {
    log.info("PROFILE_INJECT", `no Wall account for "${username}" (${e?.message || "404"})`);
    profileCache.set(key, null);
    return null;
  }
  let achievementCount = 0;
  if (profile?.id) {
    try {
      const a = (await piReq(
        "GET",
        `/v2/users/${profile.id}/achievements`,
      )) as any[];
      achievementCount = a?.length ?? 0;
    } catch (e: any) {
      log.debug("PROFILE_INJECT", `achievements fetch failed for ${username}: ${e?.message || ""}`);
    }
  }
  profile.__achCount = achievementCount;
  profileCache.set(key, profile);
  return { profile, achievementCount };
}

function renderDivider(): string {
  return `<div class="wd-divider"><span class="wd-divider-chip"><span class="wd-divider-chip-dot"></span><span>${esc(t("profileTitle"))}</span></span></div>`;
}

function renderEmpty(username: string): string {
  const message = t("profileNoAccount", { name: esc(username) });
  // The message contains the (already-escaped) username verbatim, so re-escape
  // only the parts that came from the dictionary.
  return `${renderDivider()}
    <div class="wd-body">
      <div class="wd-empty">
        ${message}<br>
        ${esc(t("profileNoAccountCta"))} <a href="https://the-wall.vai-rice.space" target="_blank" rel="noopener">the-wall.vai-rice.space</a>.
      </div>
    </div>`;
}

/** Deterministic 0..4 from a username so each user always gets the same bio. */
function pickBioFallbackIndex(username: string): number {
  let h = 0;
  for (let i = 0; i < username.length; i++) {
    h = ((h << 5) - h + username.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 5;
}

function fallbackBio(username: string): string {
  const i = pickBioFallbackIndex(username);
  return t(`profileBioFallback${i + 1}`);
}

/**
 * The username "vai" is the developer of the extension — give them a small
 * easter egg. Comparison is case-insensitive so people can't beat us to it.
 */
function isVai(username: string | undefined): boolean {
  return (username || "").trim().toLowerCase() === "vai";
}

function localiseGlobalRole(role: string | undefined): string {
  const r = (role || "user").toLowerCase();
  if (r === "owner")     return t("profileRoleOwner");
  if (r === "admin")     return t("profileRoleAdmin");
  if (r === "moderator") return t("profileRoleModerator");
  return t("profileRoleUser");
}

function localiseClanRole(role: string | undefined): string | null {
  const r = (role || "").toLowerCase();
  if (r === "admin")     return t("profileClanRoleAdmin");
  if (r === "moderator") return t("profileClanRoleModerator");
  if (r === "member")    return t("profileClanRoleMember");
  return null;
}

function avatarUrl(profile: any): string {
  // /api/avatar?userId=<uuid> returns the custom avatar or 404 — falls back
  // to Discord proxy via onerror handler in the template.
  return `${piRoot()}/avatar?userId=${encodeURIComponent(profile.id)}`;
}

function discordAvatarUrl(profile: any): string | null {
  // We don't have the snowflake here unless discord_id is on the public
  // profile. If so we can use the second-level fallback chain in the <img>.
  if (profile.discord_id) {
    return `${piRoot()}/discord/avatar?userId=${encodeURIComponent(profile.discord_id)}`;
  }
  return null;
}

function renderProfile(profile: any, achievementCount: number, username: string): string {
  const displayName = profile.username || username;
  const vai = isVai(displayName);

  // -- Bio (or one of 5 generic fallbacks)
  const hasBio = !!(profile.bio && String(profile.bio).trim());
  const bioText = hasBio ? String(profile.bio) : fallbackBio(displayName);
  const bioCls  = hasBio ? "wd-bio" : "wd-bio wd-bio-fallback";
  const bioHtml = `<div class="${bioCls}">${replaceEmotes(esc(bioText))}</div>`;

  // -- Social links
  const linksHtml = (profile.social_links || []).map((l: any) => {
    const u = (l.url || "").replace(/"/g, "&quot;");
    return `<a href="${u}" target="_blank" rel="noopener">${esc(l.label || l.url || "link")}</a>`;
  }).join("");
  const linksBlock = linksHtml
    ? `<div class="wd-section-title">${esc(t("profileLinks"))}</div><div class="wd-links">${linksHtml}</div>`
    : "";

  // -- Pinned templates
  const pinsHtml = (profile.pinned_templates || []).map((p: any) =>
    `<div class="wd-pin" title="${esc(p.name || "")}" style="background-image:url('${piRoot()}/v2/templates/${encodeURIComponent(p.id)}/preview?size=64')"></div>`,
  ).join("");
  const pinsBlock = pinsHtml
    ? `<div class="wd-section-title">${esc(t("profilePinned"))}</div><div class="wd-pins">${pinsHtml}</div>`
    : "";

  // -- Roles (global + clan)
  const globalRole = localiseGlobalRole(profile.global_role);
  const clanRole   = localiseClanRole(profile.primary_clan_role);
  const clanName   = profile.primary_clan_name || profile.clans?.[0]?.clan_name || null;
  const roleLine =
    vai
      ? `<span class="wd-vai-badge">${esc(t("profileVaiDevBadge"))}</span>` +
        (clanName ? ` · ${esc(clanName)}` : "")
      : [
          globalRole,
          clanRole ? `${clanRole}` : null,
          clanName ? `· ${esc(clanName)}` : null,
        ].filter(Boolean).join(" ");

  // -- Achievement count with proper pluralization
  const achLabel = pluralize(achievementCount, "profileAchievement");
  const achLine  = `${achievementCount} ${esc(achLabel)}`;

  // -- Avatar fallback chain: custom → discord → hide.
  const discordFallback = discordAvatarUrl(profile);
  const avatarOnError = discordFallback
    ? `this.onerror=()=>{this.style.display='none'};this.src='${discordFallback.replace(/'/g, "\\'")}';`
    : `this.style.display='none'`;

  // -- VAI easter egg note (just above the bio)
  const vaiNote = vai
    ? `<div class="wd-vai-note">${esc(t("profileVaiDevNote"))}</div>`
    : "";

  return `${renderDivider()}
    <div class="wd-body">
      <div class="wd-head">
        <img class="wd-avatar" src="${avatarUrl(profile)}" alt="" onerror="${avatarOnError}">
        <div class="wd-head-text">
          <div class="wd-name">${esc(displayName)}</div>
          <div class="wd-meta">${roleLine}</div>
          <div class="wd-meta">${achLine}</div>
        </div>
      </div>
      ${vaiNote}${bioHtml}${linksBlock}${pinsBlock}
    </div>`;
}

async function maybeInject(modal: Element): Promise<void> {
  if (modal.querySelector(`#${SECTION_ID}`)) return;
  (modal as HTMLElement).dataset.wdProfileInjected = "1";

  const username = extractUsername(modal);
  if (!username) {
    log.info("PROFILE_INJECT", "no username in modal");
    return;
  }
  log.debug("PROFILE_INJECT", `resolving "${username}"`);

  const section = document.createElement("section");
  section.id = SECTION_ID;
  section.classList.toggle("wd-dark", isWalldevDark());
  // Skeleton header while we fetch — gives the modal something to render in
  // the time it takes the backend to respond.
  section.innerHTML = `${renderDivider()}<div class="wd-body"><div class="wd-empty">${esc(t("profileLoading"))}</div></div>`;

  // Insert before the button-container if present, else append to modal.
  const btns = modal.querySelector(".btn-container");
  if (btns) modal.insertBefore(section, btns);
  else modal.appendChild(section);

  const data = await fetchProfileByUsername(username);

  // Re-check that the modal is still open before swapping content.
  if (!document.body.contains(section)) return;

  if (!data) {
    section.innerHTML = renderEmpty(username);
    log.info("PROFILE_INJECT", `injected empty section for "${username}"`);
    return;
  }
  section.innerHTML = renderProfile(data.profile, data.achievementCount, username);
  log.ok("PROFILE_INJECT", `injected profile for "${username}" (avatar+bio+links+pins)`);
  // Easter egg: opening VAI's profile unlocks the "found_the_dev" achievement.
  if (isVai(data.profile.username || username)) {
    triggerFoundTheDev();
  }
}

export function startSiteProfileInject(): void {
  if (observer) return;
  injectCss();

  // Scan for already-open modals on boot.
  document.querySelectorAll(MODAL_SEL).forEach((m) => { maybeInject(m).catch(() => {}); });

  observer = new MutationObserver((muts) => {
    for (const mu of muts) {
      mu.addedNodes.forEach((n) => {
        if (!(n instanceof Element)) return;
        if (n.matches?.(MODAL_SEL)) maybeInject(n).catch(() => {});
        n.querySelectorAll?.(MODAL_SEL).forEach((m) => { maybeInject(m).catch(() => {}); });
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  log.ok("PROFILE_INJECT", "MutationObserver attached");
}
