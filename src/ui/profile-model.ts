/**
 * Pure helpers for the Profile sub-section (social-link editing + pinned
 * templates). DOM-free so they are unit-testable bare-Bun
 * (tests/extension/profile-model.test.ts); profile-tab.ts owns the wiring.
 */

export interface SocialLink {
  label: string;
  url: string;
}

/** Emoji icon guess for a social URL (purely cosmetic). */
export function guessIcon(url: string): string {
  const u = url.toLowerCase();
  if (u.includes("twitter.com") || u.includes("x.com")) return "🐦";
  if (u.includes("github.com")) return "🐙";
  if (u.includes("discord.")) return "💬";
  if (u.includes("twitch.tv")) return "🎮";
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "▶️";
  if (u.includes("t.me") || u.includes("telegram.")) return "✈️";
  if (u.includes("instagram.")) return "📷";
  if (u.includes("mailto:") || u.startsWith("mail")) return "✉️";
  return "🔗";
}

/** Add a missing scheme: bare host → https://, bare address → mailto:. */
export function normaliseUrl(raw: string): string {
  const v = raw.trim();
  if (!v) return v;
  if (/^[a-z]+:/i.test(v)) return v;
  if (v.includes("@") && !v.includes("/")) return "mailto:" + v;
  return "https://" + v;
}

/** Would the (normalised) input parse as a URL at all? */
export function isUrlValid(raw: string): boolean {
  if (!raw) return false;
  try {
    new URL(normaliseUrl(raw));
    return true;
  } catch {
    return false;
  }
}

/** Caption under a pinned-template thumbnail (12 chars, like the old V2 UI). */
export function pinCaption(name?: string): string {
  return (name || "").slice(0, 12);
}
