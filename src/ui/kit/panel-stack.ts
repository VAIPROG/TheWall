/**
 * Panel stack — the reusable push/back navigation primitive. A section (e.g.
 * Community, or the Admin console) hands a root screen; drilling in pushes a new
 * screen with a "‹ Back" header, popping returns. Fits a narrow/mobile panel and
 * nests to any depth. See the Phase 3 UI design.
 */
import { esc } from "../../helpers";

export interface PanelScreen {
  /** Shown in the back header (ignored for the root screen). */
  title: string;
  /** Returns the screen's inner HTML. Called every time the screen is shown. */
  render: () => string;
  /** Wire listeners after render. `root` is the stack container. */
  onMount?: (root: HTMLElement) => void;
}

export class PanelStack {
  private stack: PanelScreen[] = [];

  constructor(private readonly container: HTMLElement) {
    container.classList.add("wd-stack");
  }

  /** Depth of the stack (1 = root only). */
  get depth(): number {
    return this.stack.length;
  }

  /** Replace the whole stack with a single root screen. */
  reset(root: PanelScreen): void {
    this.stack = [root];
    this.paint();
  }

  /** Drill into a new screen. */
  push(screen: PanelScreen): void {
    this.stack.push(screen);
    this.paint();
  }

  /** Return to the previous screen (no-op at the root). */
  pop(): void {
    if (this.stack.length > 1) {
      this.stack.pop();
      this.paint();
    }
  }

  /** Re-render the current screen in place (e.g. after a data refresh). */
  refresh(): void {
    if (this.stack.length) this.paint();
  }

  private paint(): void {
    const top = this.stack[this.stack.length - 1];
    if (!top) {
      this.container.innerHTML = "";
      return;
    }
    const hasBack = this.stack.length > 1;
    const back = hasBack
      ? `<div class="wd-stack-back" role="button" tabindex="0"><span aria-hidden="true">‹</span>${esc(top.title)}</div>`
      : "";
    this.container.innerHTML = `${back}<div class="wd-stack-screen">${top.render()}</div>`;
    if (hasBack) {
      const btn = this.container.querySelector<HTMLElement>(".wd-stack-back");
      btn?.addEventListener("click", () => this.pop());
      btn?.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") {
          e.preventDefault();
          this.pop();
        }
      });
    }
    top.onMount?.(this.container);
  }
}
