import { $ } from "./helpers";
import { ic } from "./icons";
import { applyTheme } from "./theme";

export function mountReopener(): void {
  if ($("walldev-reopen")) return;
  const b = document.createElement("div");
  b.id = "walldev-reopen";
  b.innerHTML = ic("grid") + " wall dev";
  Object.assign(b.style, {
    position: "fixed",
    right: "12px",
    bottom: "12px",
    zIndex: "1000001",
    cursor: "pointer",
    background: "var(--bg)",
    color: "var(--text)",
    padding: "4px 8px",
    font: 'bold 11px "MS Sans Serif",sans-serif',
    border: "2px solid",
    borderColor: "var(--light) var(--dark) var(--dark) var(--light)",
  });
  b.onclick = () => {
    const w = $("walldev-tool");
    if (w) (w as HTMLElement).style.display = "block";
    b.remove();
  };
  document.body.appendChild(b);
  applyTheme();
}
