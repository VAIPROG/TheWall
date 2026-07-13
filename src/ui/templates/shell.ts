/**
 * Templates super-tab — a panel-stack of Browse (root) → Detail (drill-in) →
 * Publish. One pane hosts a {@link PanelStack}; screens are `PanelScreen`s whose
 * listeners live in `onMount` (re-wired on every push/pop). Built on the V3
 * backend (prod v6.2.2); no legacy calls. See the Part-B plan.
 */
import { PanelStack, type PanelScreen } from "../kit/panel-stack";
import { $ } from "../../helpers";
import { browseScreen } from "./browse";

// Screen factories. Browse/Detail/Publish get their real implementations in
// later slices; kept behind this indirection so the shell + navigation can be
// built and tested first.
export interface StackScreens {
  browse: () => PanelScreen;
  detail: (id: string) => PanelScreen;
  publish: (handoff: unknown) => PanelScreen;
}

export function makeStackScreens(): StackScreens {
  return {
    browse: () => browseScreen(),
    detail: (id: string) => ({
      title: "Template",
      render: () => `<div id="tpl-detail">${id}</div>`,
      onMount: () => {},
    }),
    publish: (_handoff: unknown) => ({
      title: "Publish",
      render: () => `<div id="tpl-publish" class="wd-empty">Publish (coming next)</div>`,
      onMount: () => {},
    }),
  };
}

let stack: PanelStack | null = null;
let screens: StackScreens = makeStackScreens();

/** Pane markup mounted into the window body (data-p="tp"). */
export function buildTemplatesPane(): string {
  return `<div class="wp-pane" data-p="tp"><div id="tpl-stack" class="wd-stack"></div></div>`;
}

/** Instantiate the stack and reset it to Browse. Called once from wireUI. */
export function wireTemplates(_win: HTMLElement): void {
  const el = $("tpl-stack");
  if (!el) return;
  screens = makeStackScreens();
  stack = new PanelStack(el);
  stack.reset(screens.browse());
}

/** Push the Detail screen for a template id (used by Browse cards). */
export function openDetail(id: string): void {
  stack?.push(screens.detail(id));
}

/** Push the Publish screen, optionally pre-filled from an Overlay hand-off. */
export function openPublish(handoff?: unknown): void {
  stack?.push(screens.publish(handoff ?? {}));
}

/** Return to Browse (used after publish/delete). */
export function resetToBrowse(): void {
  if (stack) stack.reset(screens.browse());
}
