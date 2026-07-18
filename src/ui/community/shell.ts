/**
 * Community super-tab — a panel-stack of Hub (root) → Thread (drill-in) →
 * Clan → Browse. One pane hosts a {@link PanelStack}; screens are `PanelScreen`s
 * whose listeners live in `onMount` (re-wired on every push/pop). Built on the V3
 * backend; no legacy Social/Clan calls. See the Community super-tab plan.
 */
import { PanelStack, type PanelScreen } from "../kit/panel-stack";
import { $ } from "../../helpers";
import { hubScreen } from "./hub";
import { threadScreen } from "./thread";
import { clanScreen } from "./clan";
import { browseScreen } from "./browse";
import type { ChatRef } from "./api";

// Re-export the real ChatRef (owned by api.ts) so existing importers of the
// shell's `ChatRef` keep working.
export type { ChatRef };

// Screen factories, kept behind this indirection so the shell + navigation can
// be built and tested independently of the screens.
export interface StackScreens {
  hub: () => PanelScreen;
  thread: (ref: ChatRef, title: string) => PanelScreen;
  clan: (id: string) => PanelScreen;
  browse: () => PanelScreen;
}

export function makeStackScreens(): StackScreens {
  return {
    hub: hubScreen,
    thread: (ref: ChatRef, title: string) => threadScreen(ref, title),
    clan: (id: string) => clanScreen(id),
    browse: browseScreen,
  };
}

let stack: PanelStack | null = null;
let screens: StackScreens = makeStackScreens();

/** Pane markup mounted into the window body (data-p="co"). */
export function buildCommunityPane(): string {
  return `<div class="wp-pane" data-p="co"><div id="comm-stack" class="wd-stack"></div></div>`;
}

/** Instantiate the stack and reset it to Hub. Called once from wireUI. */
export function wireCommunity(_win: HTMLElement): void {
  const el = $("comm-stack");
  if (!el) return;
  screens = makeStackScreens();
  stack = new PanelStack(el);
  stack.reset(screens.hub());
}

/** Push the Thread screen for a chat ref (used by Hub rows). */
export function openThread(ref: ChatRef, title = ""): void {
  stack?.push(screens.thread(ref, title));
}

/** Push the Clan screen for a clan id. */
export function openClan(id: string): void {
  stack?.push(screens.clan(id));
}

/** Push the Browse screen (clan/chat discovery). */
export function openBrowse(): void {
  stack?.push(screens.browse());
}

/** Return to Hub (used after navigation drill-outs). */
export function resetToHub(): void {
  if (stack) stack.reset(screens.hub());
}
