import { $ } from "./helpers";

export function styleSheet(): string {
  return `
#walldev-tool{--bg:#c0c0c0;--text:#000;--light:#fff;--shadow:#808080;--dark:#404040;--title1:#000080;--title2:#1084d0;--field:#fff;--fieldtext:#000;--group:#dfdfdf;--led:#3f6;--accent:#000080;--link:#00f;--sub:#555}
#walldev-tool.wd-dark{--bg:#2c2c2c;--text:#fff;--light:#5a5a5a;--shadow:#141414;--dark:#000;--title1:#3838aa;--title2:#1084d0;--field:#0f0f0f;--fieldtext:#fff;--group:#3a3a3a;--led:#2d924d;--accent:#2889ff;--link:#7aa6ff;--sub:#aaa}
#walldev-tool{position:fixed;top:64px;right:20px;width:320px;z-index:1000000;background:var(--bg);color:var(--text);
  font:11px "MS Sans Serif",Tahoma,Arial,sans-serif;user-select:none;border:2px solid;border-color:var(--light) var(--dark) var(--dark) var(--light);box-shadow:3px 3px 8px rgba(0,0,0,.55)}
#walldev-tool.wd-cozy{box-shadow:0 0 0 1px rgba(0,0,0,.3),4px 5px 16px rgba(0,0,0,.55),0 0 22px rgba(120,150,255,.12);border-radius:2px}
#walldev-tool.wd-cozy .wp-content{position:relative}
#walldev-tool.wd-cozy .wp-content::after{content:"";position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(0,0,0,.03) 0 1px,transparent 1px 3px);mix-blend-mode:multiply;opacity:.4;z-index:0}
#walldev-tool.wd-dark.wd-cozy .wp-content::after{background:repeating-linear-gradient(0deg,rgba(255,255,255,.02) 0 1px,transparent 1px 3px);mix-blend-mode:screen}
#walldev-tool.collapsed .wp-body{display:none}
.wd-ic{vertical-align:-2px;margin-right:3px;flex:none}
.wp-titlebar{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:3px 4px;cursor:grab;
  background:linear-gradient(90deg,var(--title1),var(--title2));color:#fff;font-weight:bold}
.wp-titlebar .wp-led{width:8px;height:8px;border-radius:50%;background:#f33;box-shadow:0 0 4px #f33;display:inline-block;margin-right:5px}
.wp-titlebar.on .wp-led{background:var(--led);box-shadow:0 0 5px var(--led)}
.wp-tcap{display:flex;align-items:center;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.wp-tbtns{display:flex;gap:3px;align-items:center}
.wp-tbtn{width:16px;height:14px;line-height:12px;text-align:center;background:var(--bg);color:var(--text);font-weight:bold;cursor:pointer;
  border:1px solid;border-color:var(--light) var(--dark) var(--dark) var(--light)}
.wp-tbtn:active{border-color:var(--dark) var(--light) var(--light) var(--dark)}
.wp-tabs{display:flex;flex-wrap:wrap;gap:2px;padding:4px 4px 0}
.wp-tab{display:flex;align-items:center;padding:3px 6px;cursor:pointer;background:var(--bg);color:var(--text);border:1px solid;border-color:var(--light) var(--shadow) var(--shadow) var(--light);border-bottom:none;margin-bottom:-1px}
.wp-tab .wd-ic{margin-right:3px}
.wp-tab.active{font-weight:bold;padding-top:5px;z-index:2;position:relative}
.wp-content{border:1px solid;border-color:var(--light) var(--shadow) var(--shadow) var(--light);margin:0 4px 4px;padding:8px;max-height:68vh;overflow:auto}
.wp-pane{display:none}.wp-pane.active{display:block}
.wp-group{border:2px groove var(--group);padding:8px;margin-bottom:9px;position:relative}
.wp-legend{position:absolute;top:-8px;left:6px;background:var(--bg);padding:0 4px;font-weight:bold;display:flex;align-items:center}
.wp-section-hdr{font-size:10px;font-weight:bold;color:var(--sub);text-transform:uppercase;letter-spacing:1.2px;display:flex;align-items:center;gap:4px;margin:14px 0 6px 2px;padding-bottom:4px;border-bottom:1px dashed var(--shadow);opacity:.9}
.wp-section-hdr:first-child{margin-top:2px}
.wp-resize-handle{position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;z-index:1000;user-select:none;background:var(--bg);border-top:1px solid var(--shadow);border-left:1px solid var(--shadow);box-shadow:inset 1px 1px 0 var(--light)}
.wp-resize-handle::after{content:"";position:absolute;right:2px;bottom:2px;width:12px;height:12px;background:linear-gradient(135deg,transparent 0 33%,var(--dark) 33% 40%,transparent 40% 60%,var(--dark) 60% 67%,transparent 67% 87%,var(--dark) 87% 94%,transparent 94% 100%);pointer-events:none}
.wp-resize-handle:hover{filter:brightness(1.1)}
.wp-resize-handle:active{border-top-color:var(--dark);border-left-color:var(--dark);box-shadow:inset -1px -1px 0 var(--light)}
`;
}

export function styleSheet2(): string {
  return `
.wp-btn{display:flex;align-items:center;justify-content:center;width:100%;box-sizing:border-box;margin-top:5px;padding:4px 6px;text-align:center;cursor:pointer;text-decoration:none;color:var(--text);
  background:var(--bg);font:11px "MS Sans Serif",Tahoma,sans-serif;border:1px solid;border-color:var(--light) var(--dark) var(--dark) var(--light)}
.wp-btn:active{border-color:var(--dark) var(--light) var(--light) var(--dark);padding:5px 5px 3px 7px}
.wp-btn.active-state{background:var(--box-bg-hover,#e6e6e6);box-shadow:inset 1px 1px var(--shadow);font-weight:bold}
.wp-btn.primary{font-weight:bold}
#walldev-tool:not(.wd-dark) .wp-btn.primary{background:#d8d8f0}
#walldev-tool.wd-dark .wp-btn.primary{background:#243056}
.wp-row{display:flex;gap:6px}.wp-row>*{flex:1}
.wp-input,select.wp-input,textarea.wp-input{width:100%;box-sizing:border-box;background:var(--field);color:var(--fieldtext);padding:3px;font:11px monospace;border:2px inset var(--shadow)}
textarea.wp-input{resize:vertical;min-height:54px}
.wp-card{display:flex;align-items:center;gap:9px;padding:6px;margin-top:5px;background:var(--field);color:var(--fieldtext);border:2px inset var(--shadow)}
.wp-card img,.wp-card .ph{width:40px;height:40px;flex:none;border:1px solid var(--shadow);object-fit:cover;background:#808080;image-rendering:pixelated}
.wp-card .nm{font-weight:bold;color:var(--accent)}.wp-card .sub{font-size:10px;color:var(--sub)}
.wp-badge{display:inline-block;font-size:9px;font-weight:bold;padding:1px 5px;margin-left:4px;border:1px solid var(--shadow);vertical-align:1px}
.wp-badge.dev{background:#5b2d8c;color:#fff}.wp-badge.owner{background:#a8201f;color:#fff}.wp-badge.mod{background:#1e6e2c;color:#fff}.wp-badge.member{background:#888;color:#fff}
`;
}

export function styleSheet3(): string {
  return `
.wp-list{max-height:130px;overflow:auto;background:var(--field);color:var(--fieldtext);border:2px inset var(--shadow);padding:2px}
.wp-li{display:flex;align-items:center;gap:8px;padding:4px;border-bottom:1px dotted var(--shadow)}
.wp-li img,.wp-li .ph{width:30px;height:30px;flex:none;border:1px solid var(--shadow);background:#808080;object-fit:cover}
.wp-li b{font-size:11px}.wp-li .sub{color:var(--sub);font-size:10px}
.wp-sw{display:flex;flex-wrap:wrap;gap:2px;margin-top:4px}
.wp-sw button{width:16px;height:16px;border:1px solid #555;cursor:pointer;padding:0}
.wp-sw button.sel{outline:2px solid var(--accent);outline-offset:-2px}
.wp-chat{height:150px;overflow:auto;background:var(--field);color:var(--fieldtext);border:2px inset var(--shadow);padding:4px;font-size:11px;line-height:1.4}
.wp-chat .m{margin-bottom:4px;display:flex;gap:4px;align-items:flex-start}
.wp-chat .m .bd{flex:1}.wp-chat .m .au{font-weight:bold;color:var(--accent)}
.wp-chat .m .ts{color:var(--sub);font-size:10px;margin-left:4px}
.wp-chat .m .del{cursor:pointer;color:#c33;flex:none}
.wd-emote{display:inline;height:20px;vertical-align:middle;margin:0 1px}
.wp-chat-input-row{display:flex;gap:4px;align-items:stretch;margin-top:4px}
.wp-chat-input{flex:1;min-height:46px;resize:vertical}
.wp-emoji-btn{flex:0 0 28px;width:28px;height:28px;padding:0;font-size:13px;display:flex;align-items:center;justify-content:center;align-self:flex-start}
.wp-emoji-picker{display:none;position:fixed;z-index:1000000;background:var(--bg);border:2px solid;border-color:#fff #404040 #404040 #fff;width:280px;box-shadow:4px 4px 0 rgba(0,0,0,.5)}
.wp-emoji-picker.open{display:flex}
.wp-emoji-picker .grp-label{flex-basis:100%;font-weight:bold;font-size:10px;color:var(--sub);padding:2px 4px;border-bottom:1px solid var(--shadow);margin:2px 0}
.wp-mention-suggest{display:none;position:absolute;z-index:9999;background:var(--field);color:var(--fieldtext);border:2px outset var(--light);padding:2px;max-width:200px;max-height:140px;overflow-y:auto;font-size:11px;box-shadow:3px 3px 6px rgba(0,0,0,.4)}
.wp-mention-suggest.open{display:block}
.wp-mention-suggest .item{padding:3px 6px;cursor:pointer;display:flex;gap:4px;align-items:center}
.wp-mention-suggest .item.sel,.wp-mention-suggest .item:hover{background:var(--accent);color:#fff}
.wp-mention{color:var(--accent);font-weight:bold;background:rgba(0,0,128,.1);padding:0 2px;border-radius:2px;cursor:pointer}

/* ---------- Profile: Social links UX ---------- */
.wp-social-list{display:flex;flex-direction:column;gap:4px;min-height:24px}
.wp-empty{padding:8px;color:var(--sub);font-style:italic;text-align:center}
.wp-social-item{display:flex;align-items:center;gap:6px;padding:6px;
  background:var(--field);color:var(--fieldtext);
  border:1px solid;border-color:var(--light) var(--shadow) var(--shadow) var(--light);
  box-shadow:inset 1px 1px 0 var(--bg);
  font-size:11px;cursor:default;transition:background .12s}
.wp-social-item:hover{background:var(--group)}
.wp-social-item.dragging{opacity:.4}
.wp-social-item.dropping{outline:2px dashed var(--accent);outline-offset:-1px}
.wp-social-grip{cursor:grab;color:var(--shadow);font-size:14px;letter-spacing:-2px;padding:0 2px;user-select:none}
.wp-social-grip:active{cursor:grabbing}
.wp-social-icon{font-size:16px;width:20px;text-align:center;flex:none}
.wp-social-text{flex:1;min-width:0;overflow:hidden}
.wp-social-label{font-weight:bold;color:var(--text);white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.wp-social-url{font-size:10px;color:var(--accent);text-decoration:none;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;display:block}
.wp-social-url:hover{text-decoration:underline}
.wp-social-edit,.wp-social-del{flex:none;width:22px;height:22px;padding:0;
  background:var(--bg);color:var(--text);
  border:1px solid;border-color:var(--light) var(--dark) var(--dark) var(--light);
  font:bold 12px sans-serif;cursor:pointer;line-height:1}
.wp-social-edit:active,.wp-social-del:active{border-color:var(--dark) var(--light) var(--light) var(--dark);padding:1px 0 0 1px}
.wp-social-del{color:#c33}
.wp-social-editor{display:flex;align-items:flex-start;gap:6px;padding:8px;
  background:var(--field);color:var(--fieldtext);
  border:2px solid var(--accent);
  box-shadow:0 0 0 1px var(--bg) inset,2px 2px 4px rgba(0,0,0,.25);
  animation:wp-social-pop .15s ease-out}
@keyframes wp-social-pop{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
.wp-social-editor-icon{font-size:22px;width:28px;text-align:center;flex:none;margin-top:2px}
.wp-social-editor-fields{flex:1;display:flex;flex-direction:column;gap:4px;min-width:0}
.wp-social-editor-fields .wp-input{margin:0}
.wp-social-editor-actions{display:flex;flex-direction:column;gap:2px;flex:none}
.wp-social-editor-actions .wp-btn{width:auto;min-width:28px;padding:3px 6px;margin:0}

/* ---------- Emote channel manager (settings) ---------- */
.wp-channels-list{display:flex;flex-direction:column;gap:3px;margin-bottom:6px;min-height:14px}
.wp-channel-item{display:flex;align-items:center;gap:6px;padding:4px 6px;
  background:var(--field);color:var(--fieldtext);
  border:1px solid;border-color:var(--light) var(--shadow) var(--shadow) var(--light);
  font-size:11px}
.wp-channel-item.builtin{background:var(--group);color:var(--sub);font-style:italic}
.wp-channel-item .nm{font-weight:bold;color:var(--accent)}
.wp-channel-item .tid{color:var(--sub);font-size:10px;font-family:monospace}
.wp-channel-item .badge{font-size:9px;padding:1px 5px;background:var(--accent);color:#fff;border-radius:2px;text-transform:uppercase}
.wp-channel-item .grow{flex:1;display:flex;gap:4px;align-items:center;min-width:0}
.wp-channel-item .rm{cursor:pointer;color:#c33;flex:none;font-size:14px;line-height:1;padding:0 4px}
.wp-channel-add{display:flex;gap:4px;margin-top:4px}
.wp-channel-add .wp-input{margin:0}
.wp-channel-add .wp-btn{margin:0;width:auto;flex:none}
.wp-link-row{display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px dashed var(--shadow)}
.wp-link-row:last-child{border-bottom:none}
.wp-link-name{flex:0 0 86px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:bold}
.wp-link-status{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wp-link-status .ok{color:var(--ok,#1e6e2c);font-weight:bold}
.wp-link-status .off{color:var(--sub)}
.wp-link-row .wp-btn{flex:none;width:auto;margin:0;padding:2px 10px;white-space:nowrap}
.wp-links-actions{display:flex;gap:4px;margin-top:6px}
.wp-links-actions .wp-btn{margin:0;white-space:nowrap}
.wp-links-actions .wp-btn:first-child{flex:1}
.wp-links-actions .wp-btn:last-child{flex:none;width:auto}
.wp-row-item{display:flex;align-items:center;gap:6px;padding:3px 4px;border-bottom:1px dashed var(--shadow)}
.wp-row-item:last-child{border-bottom:none}
.wp-row-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wp-btn-mini{width:auto;margin:0;padding:2px 6px}
.wp-hud{font:12px monospace;background:#000;color:#0f0;padding:3px 5px;border:2px inset var(--shadow);text-align:center}
.wp-check{display:flex;align-items:center;gap:6px;margin-top:6px;cursor:pointer}
.wp-note{font-size:10px;color:#b35;margin-top:5px;line-height:1.35}
#walldev-tool.wd-dark .wp-note{color:#f9a}
.wp-tpl-thumb{width:30px;height:30px;image-rendering:pixelated}
#walldev-overlay{position:absolute;z-index:99998 !important;pointer-events:none;image-rendering:pixelated;opacity:.6;transform-origin:top left}
#walldev-overlay.unlocked{pointer-events:auto !important;outline:1px dashed #f0f;cursor:move}
#walldev-guide{position:absolute;left:0;top:0;z-index:99997 !important;pointer-events:none;image-rendering:pixelated;opacity:.85}
.picking-mode{cursor:crosshair !important}
#walldev-toasts{position:fixed;right:16px;bottom:16px;z-index:1000001;display:flex;flex-direction:column;gap:6px;--bg:#c0c0c0;--light:#fff;--dark:#404040;--text:#000}
#walldev-toasts.wd-dark{--bg:#2c2c2c;--light:#5a5a5a;--dark:#000;--text:#fff}
.wp-toast{background:var(--bg);color:var(--text);border:2px solid;border-color:var(--light) var(--dark) var(--dark) var(--light);
  padding:7px 10px;max-width:260px;font:11px "MS Sans Serif",Tahoma,sans-serif;box-shadow:2px 2px 5px rgba(0,0,0,.5);transition:opacity .4s}
#walldev-reopen{--bg:#c0c0c0;--light:#fff;--dark:#404040;--text:#000}
#walldev-reopen.wd-dark{--bg:#2c2c2c;--light:#5a5a5a;--dark:#000;--text:#fff}
.wp-content::-webkit-scrollbar,.wp-list::-webkit-scrollbar,.wp-chat::-webkit-scrollbar{width:16px}
.wp-content::-webkit-scrollbar-thumb,.wp-list::-webkit-scrollbar-thumb,.wp-chat::-webkit-scrollbar-thumb{background:var(--bg);border:1px solid;border-color:var(--light) var(--dark) var(--dark) var(--light)}
.wp-content::-webkit-scrollbar-track,.wp-list::-webkit-scrollbar-track,.wp-chat::-webkit-scrollbar-track{background:var(--group)}

/* ---- dark-theme form-control overrides --------------------------------
 * Native form widgets (inputs/selects/file-pickers/range-thumbs/spin-buttons)
 * fall back to the UA stylesheet for whatever the class rule doesn't cover.
 * In dark mode that leaves them blinding white with white text on top —
 * unreadable. These rules force them dark whenever the panel root carries
 * .wd-dark, plus we set color-scheme so Chromium renders its native bits
 * (scrollbars, spin buttons, file-selector button) with dark UA defaults. */
#walldev-tool.wd-dark{color-scheme:dark}
#walldev-tool.wd-dark input[type="text"],
#walldev-tool.wd-dark input[type="number"],
#walldev-tool.wd-dark input[type="search"],
#walldev-tool.wd-dark input[type="email"],
#walldev-tool.wd-dark input[type="url"],
#walldev-tool.wd-dark input[type="password"],
#walldev-tool.wd-dark input[type="file"],
#walldev-tool.wd-dark textarea,
#walldev-tool.wd-dark select{
  background:var(--field) !important;
  color:var(--fieldtext) !important;
  border-color:var(--dark) var(--light) var(--light) var(--dark) !important;
}
#walldev-tool.wd-dark input[type="file"]::-webkit-file-upload-button,
#walldev-tool.wd-dark input[type="file"]::file-selector-button{
  background:var(--bg);color:var(--text);
  border:1px solid var(--light);
  font:11px "MS Sans Serif",Tahoma,sans-serif;
  padding:2px 8px;cursor:pointer;
}
#walldev-tool.wd-dark option{background:var(--field);color:var(--fieldtext)}
#walldev-tool.wd-dark input[type="range"]{accent-color:#2889ff;background:transparent}
#walldev-tool.wd-dark input[type="checkbox"]{accent-color:#2889ff}

/* Dialog overlay (alert/confirm/prompt) too */
#walldev-dialogs.wd-dark input,#walldev-dialogs.wd-dark textarea,#walldev-dialogs.wd-dark select{
  background:#0f0f0f !important;color:#fff !important;
}
`;
}

export function injectStyle(): void {
  if ($("walldev-style")) return;
  const s = document.createElement("style");
  s.id = "walldev-style";
  s.textContent = styleSheet() + styleSheet2() + styleSheet3();
  document.head.appendChild(s);
}
