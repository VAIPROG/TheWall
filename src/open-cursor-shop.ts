/**
 * Open the site's cursor inventory ("shop") modal from our extension UI.
 *
 * The inventory modal lives inside the site bundle as `y8()` — a closure-
 * scoped async function we can't call directly from a content script. The
 * cleanest fallback is to drive the same UI path a manual user would take:
 *
 *   1. Click the "User" button in the top action bar
 *      (`<button class="abtn btn action" aria-label="User">`).
 *   2. Wait one paint frame so the dropdown menu mounts.
 *   3. Find the "Cursor Inventory" menu item by aria-label and click it.
 *
 * The site's menu code synthesises aria-labels from the bracketed label
 * (`"Cursor [I]nventory"` → `"Cursor Inventory"`), so the selector below
 * matches the production build.
 *
 * If we fail to find the User button (e.g. the user isn't logged in), the
 * caller can show a hint toast instead.
 *
 * Public API:
 *   openCursorShop(): boolean   — `true` if we found and clicked something
 *                                  to open the menu path; `false` to let
 *                                  the caller surface a fallback message.
 */
import { log } from "./log";

/** Try to click the top-bar "User" button + then the "Cursor Inventory"
 *  menu item. Returns true if the first step succeeded — the menu open is
 *  the user-visible signal that everything is on track. */
export function openCursorShop(): boolean {
  const userBtn = document.querySelector<HTMLButtonElement>(
    'button.abtn[aria-label="User"]',
  );
  if (!userBtn) {
    log.warn("SHOP", "User button not found in top action bar");
    return false;
  }
  log.info("SHOP", "clicking User menu");
  userBtn.click();

  // Site mounts the dropdown synchronously, but child menu items get a
  // hover-binding step in the next microtask. Two rAF ticks is enough to
  // catch them reliably without making the user wait.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const item =
        document.querySelector<HTMLElement>(
          '[aria-label="Cursor Inventory"]',
        ) ||
        // Fallback by text content — robust against future aria-label tweaks.
        Array.from(document.querySelectorAll<HTMLElement>("button, li, a")).find(
          (el) => /cursor\s*inventory/i.test(el.textContent || ""),
        );
      if (item) {
        log.ok("SHOP", `clicking "${item.textContent?.trim()}"`);
        item.click();
      } else {
        log.warn("SHOP", "Cursor Inventory item not found in dropdown");
      }
    }),
  );
  return true;
}
