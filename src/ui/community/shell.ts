/**
 * Community super-tab — a panel-stack of Hub (root) → Thread (drill-in) →
 * Clan → Browse. One pane hosts a {@link PanelStack}; screens are `PanelScreen`s
 * whose listeners live in `onMount` (re-wired on every push/pop). Built on the V3
 * backend; no legacy Social/Clan calls. See the Community super-tab plan.
 */
import { PanelStack, type PanelScreen } from "../kit/panel-stack";
import { $ } from "../../helpers";

// Placeholder chat reference. Task 2's api.ts will own the real `ChatRef`; the
// shell will import it from there once it exists.
export type ChatRef = { kind: string; chatId?: string; userRef?: string };

// Screen factories. Hub/Thread/Clan/Browse get their real implementations in
// later slices; kept behind this indirection so the shell + navigation can be
// built and tested first.
export interface StackScreens {
  hub: () => PanelScreen;
  thread: (ref: ChatRef) => PanelScreen;
  clan: (id: string) => PanelScreen;
  browse: () => PanelScreen;
}

export function makeStackScreens(): StackScreens {
  // Real screens land in Tasks 3–6; import them here as they arrive.
  return {
    hub: () => ({
      title: "Community",
      render: () => `<div id="comm-hub" class="wd-stub"></div>`,
      onMount: () => {},
    }),
    thread: (_ref: ChatRef) => ({
      title: "Thread",
      render: () => `<div id="comm-thread" class="wd-stub"></div>`,
      onMount: () => {},
    }),
    clan: (_id: string) => ({
      title: "Clan",
      render: () => `<div id="comm-clan" class="wd-stub"></div>`,
      onMount: () => {},
    }),
    browse: () => ({
      title: "Browse",
      render: () => `<div id="comm-browse" class="wd-stub"></div>`,
      onMount: () => {},
    }),
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
export function openThread(ref: ChatRef): void {
  stack?.push(screens.thread(ref));
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
