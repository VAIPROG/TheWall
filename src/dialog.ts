import { esc } from "./helpers";
import { isWalldevDark } from "./theme";

export type DialogKind = "info" | "warn" | "error" | "ask" | "success";

function ensureHost(): HTMLElement {
  let host = document.getElementById("walldev-dialogs");
  if (host) return host;
  host = document.createElement("div");
  host.id = "walldev-dialogs";
  document.body.appendChild(host);
  document.addEventListener("wd:theme-changed", () => {
    host!.classList.toggle("wd-dark", isWalldevDark());
  });

  const style = document.createElement("style");
  style.id = "walldev-dialog-style";
  style.textContent = `
  /* ------- Win95 dialog system ------- */
  @keyframes wd-fade-in   { from { opacity:0 } to { opacity:1 } }
  @keyframes wd-pop-in    { from { transform:translate(-50%,-50%) scale(.88); opacity:0 } to { transform:translate(-50%,-50%) scale(1); opacity:1 } }
  @keyframes wd-shake     { 0%,100% { transform:translate(-50%,-50%) } 25% { transform:translate(-52%,-50%) } 50% { transform:translate(-48%,-50%) } 75% { transform:translate(-52%,-50%) } }

  #walldev-dialogs {
    position:fixed; inset:0; z-index:1000002; pointer-events:none;
    --bg:#c0c0c0; --text:#000; --light:#fff; --shadow:#808080; --dark:#404040;
    --field:#fff; --fieldtext:#000;
    --title-a:#000080; --title-b:#1084d0;
    --accent:#000080;
  }
  #walldev-dialogs.wd-dark {
    --bg:#2c2c2c; --text:#fff; --light:#5a5a5a; --shadow:#141414; --dark:#000;
    --field:#0f0f0f; --fieldtext:#fff;
    --title-a:#3838aa; --title-b:#1084d0;
    --accent:#2889ff;
  }

  #walldev-dialogs .wd-dlg-back {
    position:absolute; inset:0; pointer-events:auto;
    background:rgba(0,0,0,.45);
    animation:wd-fade-in .12s ease-out;
  }

  /* Outer Win95 window — 2px raised bezel + drop shadow */
  #walldev-dialogs .wd-dlg {
    position:absolute; left:50%; top:42%;
    transform:translate(-50%,-50%);
    min-width:340px; max-width:480px;
    background:var(--bg); color:var(--text);
    font:11px "MS Sans Serif",Tahoma,sans-serif;
    pointer-events:auto;
    border:2px solid;
    border-color:var(--light) var(--dark) var(--dark) var(--light);
    box-shadow:
      inset -1px -1px 0 var(--shadow),
      inset  1px  1px 0 var(--bg),
      4px 4px 0 rgba(0,0,0,.6);
    animation:wd-pop-in .15s ease-out;
  }
  #walldev-dialogs .wd-dlg.wd-err { animation:wd-pop-in .15s ease-out, wd-shake .35s .15s ease-in-out }

  /* Title bar — gradient, padded, with raised X button */
  #walldev-dialogs .wd-tb {
    background:linear-gradient(90deg, var(--title-a), var(--title-b));
    color:#fff; font-weight:bold; font-size:12px;
    padding:3px 3px 3px 6px;
    display:flex; align-items:center; justify-content:space-between;
    height:20px; line-height:14px;
    user-select:none;
  }
  #walldev-dialogs.wd-dark .wd-tb { background:linear-gradient(90deg,#3838aa,#1084d0) }
  #walldev-dialogs .wd-dlg.wd-err .wd-tb  { background:linear-gradient(90deg,#7a1010,#c33) }
  #walldev-dialogs .wd-dlg.wd-warn .wd-tb { background:linear-gradient(90deg,#8a5400,#e8a600); color:#000 }
  #walldev-dialogs .wd-dlg.wd-success .wd-tb { background:linear-gradient(90deg,#005000,#1da81d) }

  #walldev-dialogs .wd-tb-title {
    display:flex; align-items:center; gap:6px;
    font-size:12px; letter-spacing:0;
  }
  #walldev-dialogs .wd-tb-led {
    width:8px; height:8px; border-radius:50%;
    background:#3f6; box-shadow:0 0 4px #3f6, inset 0 0 1px rgba(255,255,255,.6);
  }
  #walldev-dialogs .wd-dlg.wd-err .wd-tb-led { background:#fc6; box-shadow:0 0 4px #fc6 }

  /* Tight little Win95 X button — smaller font so it fits the bezel */
  #walldev-dialogs .wd-tb-btns { display:flex; gap:2px; align-items:center }
  #walldev-dialogs .wd-tb-x {
    width:18px; height:16px;
    display:flex; align-items:center; justify-content:center;
    background:var(--bg); color:var(--text);
    border:1px solid;
    border-color:var(--light) var(--dark) var(--dark) var(--light);
    box-shadow:inset 1px 1px 0 var(--bg), inset -1px -1px 0 var(--shadow);
    font:bold 10px Verdana, "MS Sans Serif", sans-serif;
    line-height:1;
    cursor:pointer;
    user-select:none;
    padding:0;
  }
  #walldev-dialogs .wd-tb-x:active {
    border-color:var(--dark) var(--light) var(--light) var(--dark);
    box-shadow:inset -1px -1px 0 var(--bg), inset 1px 1px 0 var(--shadow);
    padding:1px 0 0 1px;
  }

  /* Body — fielded inset area with icon + message */
  #walldev-dialogs .wd-bd {
    padding:14px 16px;
    display:flex; gap:14px; align-items:flex-start;
  }
  #walldev-dialogs .wd-ic {
    width:36px; height:36px; flex:none;
    filter:drop-shadow(1px 1px 0 rgba(0,0,0,.45));
  }
  #walldev-dialogs .wd-msg {
    flex:1; line-height:1.45; font-size:12px;
    word-wrap:break-word; white-space:pre-wrap;
    max-height:50vh; overflow:auto;
    color:var(--text);
  }
  #walldev-dialogs .wd-msg strong { color:var(--accent) }

  #walldev-dialogs .wd-input {
    display:block; width:100%; box-sizing:border-box;
    margin-top:10px;
    padding:4px 6px;
    background:var(--field); color:var(--fieldtext);
    border:2px solid;
    border-color:var(--dark) var(--light) var(--light) var(--dark);
    box-shadow:inset 1px 1px 0 var(--shadow), inset -1px -1px 0 var(--bg);
    font:12px "MS Sans Serif", monospace;
    outline:none;
  }
  #walldev-dialogs .wd-input:focus {
    outline:1px dotted var(--accent); outline-offset:1px;
  }

  /* Bottom button row — etched separator above */
  #walldev-dialogs .wd-btns {
    padding:10px 14px 12px;
    display:flex; justify-content:flex-end; gap:6px;
    background:var(--bg);
    border-top:1px solid var(--shadow);
    box-shadow:inset 0 1px 0 var(--light);
  }
  #walldev-dialogs .wd-btn {
    min-width:84px; padding:5px 14px;
    background:var(--bg); color:var(--text);
    border:2px solid;
    border-color:var(--light) var(--dark) var(--dark) var(--light);
    box-shadow:inset 1px 1px 0 var(--bg), inset -1px -1px 0 var(--shadow);
    font:11px "MS Sans Serif",Tahoma,sans-serif;
    cursor:pointer;
  }
  #walldev-dialogs .wd-btn:hover { filter:brightness(1.04) }
  #walldev-dialogs .wd-btn:active {
    border-color:var(--dark) var(--light) var(--light) var(--dark);
    box-shadow:inset -1px -1px 0 var(--bg), inset 1px 1px 0 var(--shadow);
    padding:6px 13px 4px 15px;
  }
  #walldev-dialogs .wd-btn:focus { outline:1px dotted currentColor; outline-offset:-3px }
  #walldev-dialogs .wd-btn.primary { font-weight:bold }

  /* Status-bar feel at the bottom edge — tiny detail line */
  #walldev-dialogs .wd-statusbar {
    border-top:1px solid var(--shadow);
    box-shadow:inset 0 1px 0 var(--light);
    padding:2px 8px;
    background:var(--bg);
    color:var(--shadow);
    font:10px "MS Sans Serif",sans-serif;
    display:flex; justify-content:space-between; align-items:center;
  }
  `;
  document.head.appendChild(style);
  return host;
}

function iconFor(kind: DialogKind): string {
  switch (kind) {
    case "error":   return '<svg class="wd-ic" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#c33" stroke="#fff" stroke-width="1"/><path d="M10 10l12 12M22 10L10 22" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/></svg>';
    case "warn":    return '<svg class="wd-ic" viewBox="0 0 32 32"><path d="M16 3L1 29h30z" fill="#fc0" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/><rect x="14.5" y="11" width="3" height="10" fill="#000"/><rect x="14.5" y="23" width="3" height="3" fill="#000"/></svg>';
    case "ask":     return '<svg class="wd-ic" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#06f" stroke="#fff" stroke-width="1"/><path d="M12 11c0-3 2-5 4-5s4 2 4 5c0 2-2 3-3 4s-1 2-1 3" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/><rect x="14.5" y="22" width="3" height="3" fill="#fff"/></svg>';
    case "success": return '<svg class="wd-ic" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#2a7" stroke="#fff" stroke-width="1"/><path d="M8 17l5 5 11-12" stroke="#fff" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    default:        return '<svg class="wd-ic" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#06f" stroke="#fff" stroke-width="1"/><rect x="14.5" y="13" width="3" height="11" fill="#fff"/><rect x="14.5" y="8" width="3" height="3" fill="#fff"/></svg>';
  }
}

function defaultTitleFor(kind: DialogKind): string {
  switch (kind) {
    case "error":   return "Error";
    case "warn":    return "Warning";
    case "ask":     return "Confirm";
    case "success": return "Success";
    default:        return "The Wall Dev";
  }
}

interface DialogOpts {
  title?: string;
  message: string;
  kind?: DialogKind;
  okText?: string;
  cancelText?: string;
  showCancel?: boolean;
  prompt?: boolean;
  defaultValue?: string;
  statusText?: string;
}

export function openDialog(opts: DialogOpts): Promise<string | boolean | null> {
  return new Promise((resolve) => {
    const host = ensureHost();
    host.classList.toggle("wd-dark", isWalldevDark());

    const kind = opts.kind || "info";
    const klass =
      kind === "error"   ? " wd-err"     :
      kind === "warn"    ? " wd-warn"    :
      kind === "success" ? " wd-success" : "";
    const title = opts.title || defaultTitleFor(kind);

    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <div class="wd-dlg-back"></div>
      <div class="wd-dlg${klass}" role="dialog" aria-modal="true">
        <div class="wd-tb">
          <span class="wd-tb-title">
            <span class="wd-tb-led"></span>
            <span>${esc(title)}</span>
          </span>
          <span class="wd-tb-btns">
            <span class="wd-tb-x" role="button" title="Close" tabindex="-1">✕</span>
          </span>
        </div>
        <div class="wd-bd">
          ${iconFor(kind)}
          <div class="wd-msg">${esc(opts.message)}${opts.prompt
            ? `<input type="text" class="wd-input" value="${esc(opts.defaultValue || "")}">`
            : ""}</div>
        </div>
        <div class="wd-btns">
          ${opts.showCancel || opts.prompt
            ? `<button class="wd-btn wd-cancel">${esc(opts.cancelText || "Cancel")}</button>`
            : ""}
          <button class="wd-btn primary wd-ok">${esc(opts.okText || "OK")}</button>
        </div>
        <div class="wd-statusbar"><span>${esc(opts.statusText || "Ready")}</span><span>The Wall Dev</span></div>
      </div>`;
    host.appendChild(wrap);

    const input = wrap.querySelector<HTMLInputElement>(".wd-input");
    const okBtn = wrap.querySelector<HTMLButtonElement>(".wd-ok");
    if (input) { input.focus(); input.select(); } else { okBtn?.focus(); }

    const dismissValue = opts.prompt ? null : (opts.showCancel ? false : true);
    const close = (result: string | boolean | null) => {
      wrap.remove();
      window.removeEventListener("keydown", onKey, true);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(dismissValue); }
      else if (e.key === "Enter" && !opts.prompt) { e.preventDefault(); close(true); }
    };
    window.addEventListener("keydown", onKey, true);

    wrap.querySelector(".wd-tb-x")?.addEventListener("click", () => close(dismissValue));
    wrap.querySelector(".wd-dlg-back")?.addEventListener("click", () => close(dismissValue));
    wrap.querySelector(".wd-cancel")?.addEventListener("click", () => close(opts.prompt ? null : false));
    wrap.querySelector(".wd-ok")?.addEventListener("click", () =>
      close(opts.prompt ? (input?.value ?? "") : true),
    );
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); close(input.value); }
    });
  });
}

export function infoDlg(message: string, title = "Info"): Promise<boolean> {
  return openDialog({ message, title, kind: "info" }) as Promise<boolean>;
}
export function errorDlg(message: string, title = "Error"): Promise<boolean> {
  return openDialog({ message, title, kind: "error" }) as Promise<boolean>;
}
export function warnDlg(message: string, title = "Warning"): Promise<boolean> {
  return openDialog({ message, title, kind: "warn" }) as Promise<boolean>;
}
export function successDlg(message: string, title = "Success"): Promise<boolean> {
  return openDialog({ message, title, kind: "success" }) as Promise<boolean>;
}
export function confirmDlg(message: string, title = "Confirm"): Promise<boolean> {
  return openDialog({ message, title, kind: "ask", showCancel: true }) as Promise<boolean>;
}
export function promptDlg(message: string, defaultValue = "", title = "Input"): Promise<string | null> {
  return openDialog({ message, title, kind: "ask", prompt: true, defaultValue }) as Promise<string | null>;
}
