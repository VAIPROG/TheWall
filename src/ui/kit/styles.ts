/**
 * Foundation kit styles — the one place the reusable `wd-*` components are
 * themed. Builds on the existing token set defined in styles.ts
 * (`#walldev-tool` + `.wd-dark`): here we only add the semantic status tokens
 * and the component rules. Injected once alongside the main stylesheet.
 *
 * Everything is scoped under `#walldev-tool` (and the dialog/toast roots where
 * relevant) so it inherits the active theme's variables.
 */
export function kitStyles(): string {
  return `
/* --- icons --- */
.wd-ico { display:inline-flex; vertical-align:-0.15em; flex:none; }
.wd-ico-emoji { line-height:1; }
.wd-btn .wd-ico, .wd-legend .wd-ico, .wd-stack-back .wd-ico { margin-right:1px; }
/* Pixelated mode: one filter turns every line icon retro. Toggled by the
   .wd-pixel-icons root class (Settings › Appearance). */
#walldev-tool.wd-pixel-icons .wd-ico > svg { filter:url(#wd-pixelate); shape-rendering:crispEdges; }

/* --- semantic status tokens (light) --- */
#walldev-tool, #walldev-dialogs, #walldev-toasts {
  --ok:#0a7; --ok-bg:rgba(0,170,119,.14);
  --warn:#b57d00; --warn-bg:rgba(228,160,0,.16);
  --err:#c0392b; --err-bg:rgba(200,60,50,.12);
  --info:#1560c0; --info-bg:rgba(21,96,192,.12);
  --readout:#0a6b32;
}
#walldev-tool.wd-dark, #walldev-dialogs.wd-dark, #walldev-toasts.wd-dark {
  --ok:#3ddc84; --ok-bg:rgba(0,200,120,.15);
  --warn:#ffc402; --warn-bg:rgba(228,160,0,.18);
  --err:#ff6b6b; --err-bg:rgba(255,80,80,.15);
  --info:#7ab6ff; --info-bg:rgba(40,137,255,.15);
  --readout:#3f6;
}

/* --- buttons --- */
.wd-btn {
  font:11px "MS Sans Serif",Tahoma,sans-serif;
  padding:4px 12px; cursor:pointer;
  background:var(--bg); color:var(--text);
  border:2px solid; border-color:var(--light) var(--dark) var(--dark) var(--light);
  box-shadow:inset 1px 1px 0 var(--bg), inset -1px -1px 0 var(--shadow);
  display:inline-flex; align-items:center; justify-content:center; gap:5px;
}
.wd-btn:hover { filter:brightness(1.05); }
.wd-btn:active {
  border-color:var(--dark) var(--light) var(--light) var(--dark);
  box-shadow:inset -1px -1px 0 var(--bg), inset 1px 1px 0 var(--shadow);
  padding:5px 11px 3px 13px;
}
.wd-btn:focus-visible { outline:1px dotted currentColor; outline-offset:-3px; }
.wd-btn[disabled] { opacity:.5; cursor:default; filter:none; }
.wd-btn--full { width:100%; }
.wd-btn--sm { font-size:9px; padding:2px 8px; }
.wd-btn--lg { font-size:13px; padding:7px 18px; }
.wd-btn--primary {
  font-weight:bold; color:#fff;
  background:linear-gradient(#2f7be0,#1560c0);
  border-color:#5aa0ff #0a3c80 #0a3c80 #5aa0ff;
  box-shadow:none;
}
.wd-btn--danger {
  color:#fff; background:linear-gradient(#d0453a,#a02018);
  border-color:#ff8a7a #601008 #601008 #ff8a7a; box-shadow:none;
}
.wd-btn--ghost {
  background:transparent; border:1px solid transparent; box-shadow:none;
  color:var(--link); padding:3px 8px;
}
.wd-btn--ghost:hover { text-decoration:underline; filter:none; }
.wd-btn--icon { width:26px; height:26px; padding:0; }
.wd-btn.is-working { pointer-events:none; }
.wd-btn.is-working .wd-spin { display:inline-block; animation:wd-spin 0.7s linear infinite; }
@keyframes wd-spin { to { transform:rotate(360deg); } }

/* --- segmented / toggle --- */
.wd-seg { display:inline-flex; border:2px solid; border-color:var(--dark) var(--light) var(--light) var(--dark); }
.wd-seg > button {
  font:10px "MS Sans Serif",sans-serif; padding:3px 10px; cursor:pointer; border:0;
  background:var(--group); color:var(--sub);
}
.wd-seg > button.is-on { background:var(--accent); color:#fff; font-weight:bold; }
.wd-seg--tools { display:flex; flex-wrap:wrap; }
.wd-seg--tools > button { flex:1 0 auto; min-width:30px; font-size:14px; }

/* --- status text / pills --- */
.wd-status { font-size:11px; display:inline-flex; align-items:center; gap:4px; }
.wd-status--ok   { color:var(--ok); }
.wd-status--warn { color:var(--warn); }
.wd-status--err  { color:var(--err); }
.wd-status--info { color:var(--info); }
.wd-status--muted{ color:var(--sub); }
.wd-pill { font-size:11px; padding:2px 8px; display:inline-flex; align-items:center; gap:4px; }
.wd-pill--ok   { color:var(--ok);   background:var(--ok-bg);   border-left:3px solid var(--ok); }
.wd-pill--warn { color:var(--warn); background:var(--warn-bg); border-left:3px solid var(--warn); }
.wd-pill--err  { color:var(--err);  background:var(--err-bg);  border-left:3px solid var(--err); }
.wd-pill--info { color:var(--info); background:var(--info-bg); border-left:3px solid var(--info); }

/* --- readout (coords / live values) --- */
.wd-readout {
  font-family:Consolas,"Courier New",monospace; font-size:12px;
  color:var(--readout); display:inline-flex; gap:8px; align-items:center;
}
.wd-readout--boxed {
  background:#0a0a0a; color:#3f6; text-shadow:0 0 4px rgba(51,255,102,.35);
  border:2px solid; border-color:var(--dark) var(--light) var(--light) var(--dark);
  padding:5px 9px;
}
.wd-readout .sep { color:var(--sub); }

/* --- states --- */
.wd-empty, .wd-loading, .wd-errstate {
  font-size:11px; text-align:center; padding:10px 8px; color:var(--sub);
}
.wd-empty { border:1px dashed var(--shadow); }
.wd-empty .wd-empty-ico { font-size:26px; opacity:.5; display:block; margin-bottom:4px; }
.wd-errstate { color:var(--err); }
.wd-loading .wd-spin { display:inline-block; animation:wd-spin 0.7s linear infinite; }

/* --- badges --- */
.wd-badge { font-size:9px; padding:1px 5px; color:#fff; background:var(--accent); }
.wd-badge--owner { background:var(--accent); }
.wd-badge--admin { background:var(--info); }
.wd-badge--mod   { background:var(--ok); }
.wd-badge--member{ background:var(--sub); }

/* --- list + rows --- */
.wd-list { display:flex; flex-direction:column; background:var(--field); border:2px solid; border-color:var(--dark) var(--light) var(--light) var(--dark); }
.wd-list--scroll { max-height:260px; overflow:auto; }
.wd-row { display:flex; align-items:center; gap:6px; padding:4px 6px; font-size:11px; }
.wd-row + .wd-row { border-top:1px solid var(--shadow); }
.wd-row .grow { flex:1; min-width:0; }
.wd-row .wd-thumb { flex:none; border:1px solid var(--shadow); image-rendering:pixelated; background:var(--group); }
.wd-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(84px,1fr)); gap:6px; }

/* --- card + group --- */
.wd-card { background:var(--field); color:var(--fieldtext); border:2px solid; border-color:var(--dark) var(--light) var(--light) var(--dark); padding:6px; }
.wd-group { border:1px solid var(--shadow); padding:5px 6px; }
.wd-group > .wd-legend { font-size:9px; color:var(--sub); text-transform:uppercase; letter-spacing:.5px; margin-bottom:3px; display:flex; align-items:center; gap:4px; }
.wd-danger-zone { border:1px solid var(--err); border-left:3px solid var(--err); padding:6px; }
.wd-danger-zone > .wd-legend { color:var(--err); }

/* --- panel stack (push/back nav) --- */
.wd-stack { position:relative; overflow:hidden; }
.wd-stack-screen { animation:wd-slide-in .16s ease-out; }
.wd-stack-back {
  background:linear-gradient(90deg,var(--title1),var(--title2)); color:#fff;
  font-weight:bold; font-size:11px; padding:3px 6px; cursor:pointer;
  display:flex; align-items:center; gap:5px; user-select:none;
}
.wd-stack-back:hover { filter:brightness(1.08); }
@keyframes wd-slide-in { from { transform:translateX(14px); opacity:.4; } to { transform:none; opacity:1; } }

/* Drill-in rows (Overlay: Animation / Protect / Progress) */
.wd-drillrow {
  display:flex; align-items:center; gap:6px; width:100%; text-align:left;
  background:var(--bg); color:var(--text);
  border:2px solid; border-color:var(--light) var(--dark) var(--dark) var(--light);
  padding:6px; margin:0 0 4px; cursor:pointer; font-size:12px;
}
.wd-drillrow:hover { filter:brightness(1.05); }
.wd-drillrow:active { border-color:var(--dark) var(--light) var(--light) var(--dark); }
.wd-drillrow-t { display:flex; align-items:center; gap:4px; font-weight:bold; }
.wd-drillrow-hl { margin-left:auto; color:var(--sub); font:11px monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.wd-drillrow-arr { color:var(--sub); }
.ov-drill { animation:wd-slide-in .16s ease-out; }
.ov-drill > .wd-stack-back { margin:0 0 6px; }
/* Returning to the root slides in from the left (mirror of the drill push). */
.ov-root-back { animation:wd-slide-back .16s ease-out; }
@keyframes wd-slide-back { from { transform:translateX(-14px); opacity:.4; } to { transform:none; opacity:1; } }

/* Progress drill-in hero (big % + bar + TOTAL/DONE/LEFT) */
.ov-prog-hero { text-align:center; margin:8px 0 4px; }
.ov-prog-pct { font:bold 30px monospace; color:var(--accent); line-height:1.05; }
.ov-prog-bar { height:12px; margin-top:5px; background:var(--field); border:2px solid; border-color:var(--dark) var(--light) var(--light) var(--dark); overflow:hidden; }
.ov-prog-fill { height:100%; background:var(--accent); transition:width .3s ease; }
.ov-prog-counts { display:flex; gap:4px; margin-top:6px; }
.ov-prog-cell { flex:1; text-align:center; border:1px solid var(--shadow); padding:4px 2px; background:var(--group); }
.ov-prog-cell .k { font-size:9px; color:var(--sub); text-transform:uppercase; letter-spacing:.5px; }
.ov-prog-cell .wd-readout { font-size:13px; }

/* Templates Browse — card grid */
.wd-tplgrid { display:grid; grid-template-columns:repeat(auto-fill,minmax(92px,1fr)); gap:6px; }
.wd-tplgrid--compact { grid-template-columns:repeat(auto-fill,minmax(60px,1fr)); gap:4px; }
.wd-tplcard {
  display:flex; flex-direction:column; align-items:stretch; text-align:center; padding:3px; cursor:pointer;
  background:var(--field); color:var(--text); font:inherit;
  border:2px solid; border-color:var(--light) var(--dark) var(--dark) var(--light);
}
.wd-tplcard:hover { filter:brightness(1.05); }
.wd-tplcard:active { border-color:var(--dark) var(--light) var(--light) var(--dark); }
.wd-tplcard-img { width:100%; aspect-ratio:1/1; object-fit:contain; image-rendering:pixelated; background:var(--group); border:1px solid var(--shadow); }
.wd-tplcard-name { font-size:10px; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.wd-tplgrid--compact .wd-tplcard-name { display:none; }
.wd-tplcard-badges { display:flex; gap:2px; justify-content:center; flex-wrap:wrap; margin-top:1px; }
.wd-tplcard-badges:empty { display:none; }

/* Templates Detail drill-in */
.wd-tpl-detail { display:flex; flex-direction:column; gap:6px; }
.wd-tpl-hero { text-align:center; background:var(--group); border:2px solid; border-color:var(--dark) var(--light) var(--light) var(--dark); padding:6px; }
.wd-tpl-hero-img { max-width:100%; max-height:200px; image-rendering:pixelated; object-fit:contain; }
.wd-tpl-title { margin:0; font-size:14px; font-weight:bold; word-break:break-word; }
.wd-tpl-pills { display:flex; gap:3px; flex-wrap:wrap; }
.wd-kvgrid { display:flex; flex-direction:column; gap:2px; }
.wd-kv { display:flex; justify-content:space-between; gap:8px; font-size:11px; }
.wd-kv-k { color:var(--sub); }
.wd-kv-v { color:var(--text); text-align:right; word-break:break-word; }
.wd-notes { margin:0; padding-left:16px; font-size:11px; display:flex; flex-direction:column; gap:2px; }
.wd-bundle { margin:0; padding-left:18px; font-size:11px; }
.wd-tpl-id { font:10px monospace; color:var(--sub); text-align:center; margin-top:4px; word-break:break-all; user-select:all; opacity:.7; }

/* --- stubs (remaining Community screens land in Tasks 4–6) --- */
.wd-stub { padding:12px; color:var(--sub); font-size:11px; text-align:center; }

/* --- Community Hub --- */
.wd-comm-hub { display:flex; flex-direction:column; gap:8px; }
/* My-clan card: a clickable card row (avatar/name + member count + badge). */
.wd-comm-clan { display:flex; align-items:center; gap:8px; cursor:pointer; }
.wd-comm-clan:hover { filter:brightness(1.05); }
.wd-comm-clan-body { flex:1; min-width:0; }
.wd-comm-clan-name { font-weight:bold; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.wd-comm-clan-sub { font-size:10px; color:var(--sub); display:flex; align-items:center; gap:4px; }
.wd-comm-clan-arr { color:var(--sub); margin-left:auto; }
/* Chat rows reuse .wd-list/.wd-row; add clickability + an unread pill. */
.wd-comm-chat { cursor:pointer; }
.wd-comm-chat:hover { background:var(--group); }
.wd-comm-chat .wd-comm-unread {
  flex:none; font-size:9px; padding:1px 5px; color:#fff; background:var(--accent);
  border-radius:8px; min-width:14px; text-align:center;
}
.wd-comm-actions { display:flex; gap:6px; }
.wd-comm-actions .wd-btn { flex:1; }
/* Info card links. */
.wd-comm-info { display:flex; flex-direction:column; gap:3px; }
.wd-comm-info a { color:var(--accent); font-size:11px; text-decoration:none; }
.wd-comm-info a:hover { text-decoration:underline; }
/* Donate note: quieter, sits under the author link. */
.wd-comm-info-note { color:var(--sub); font-size:10px; margin:0 0 2px; }
/* Two Discord links side by side. */
.wd-comm-info-discord { display:flex; gap:8px; font-size:11px; color:var(--sub); }

/* ---- Thread screen (message list + composer) ---- */
.wd-comm-thread { display:flex; flex-direction:column; height:100%; min-height:0; gap:6px; }
.wd-comm-msglist {
  /* flex-fill + min-height:0 lets the list track the resizable window (the grip
     sets .wp-content max-height) while the composer stays pinned below. */
  flex:1 1 auto; min-height:0; overflow-y:auto;
  display:flex; flex-direction:column; gap:6px; padding:2px;
}
/* One message row. */
.wd-comm-msg { display:flex; flex-direction:column; gap:2px; }
.wd-comm-msg-head { display:flex; align-items:center; gap:5px; font-size:10px; color:var(--sub); }
.wd-comm-msg-av { width:16px; height:16px; border-radius:50%; flex:none; object-fit:cover; }
.wd-comm-msg-name { font-weight:bold; color:var(--txt); }
.wd-comm-msg-time { color:var(--sub); }
.wd-comm-msg-edited { font-style:italic; }
.wd-comm-msg-body { font-size:12px; overflow-wrap:anywhere; word-break:break-word; white-space:pre-wrap; }
.wd-comm-msg-body.is-deleted { color:var(--sub); font-style:italic; }
.wd-comm-msg-body code { background:var(--group); padding:0 2px; }
/* Reaction chips. */
.wd-comm-reacts { display:flex; flex-wrap:wrap; gap:4px; margin-top:1px; }
.wd-comm-react {
  font-size:10px; line-height:1; padding:2px 5px; cursor:pointer;
  border:1px solid var(--dark); background:var(--group); color:var(--txt);
  display:inline-flex; align-items:center; gap:3px;
}
.wd-comm-react:hover { filter:brightness(1.08); }
.wd-comm-react.is-on { background:var(--accent); color:#fff; border-color:var(--accent); }
.wd-comm-react-n { font-variant-numeric:tabular-nums; }
/* Per-message action buttons (edit/delete/report/pin). */
.wd-comm-acts { display:flex; gap:6px; margin-top:1px; }
.wd-comm-act {
  font-size:9px; color:var(--sub); background:none; border:0; cursor:pointer; padding:0;
}
.wd-comm-act:hover { color:var(--accent); text-decoration:underline; }
/* Inline edit. */
.wd-comm-edit-ta { width:100%; }
.wd-comm-edit-actions { display:flex; gap:6px; margin-top:4px; }
/* Composer: textarea + emoji + send. */
.wd-comm-composer { display:flex; align-items:flex-end; gap:6px; flex:none; }
.wd-comm-input { flex:1; resize:vertical; min-height:34px; }
/* Hub: chats header + "New message" inline compose. */
.wd-comm-chats-head { display:flex; align-items:center; gap:6px; }
.wd-comm-dm-compose { display:flex; align-items:center; gap:6px; }
.wd-comm-dm-compose .wp-input { flex:1; min-width:0; }
.wd-comm-chat-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* Compact (narrow window): shrink avatars + tighten message rows. */
@media (max-width: 360px) {
  .wd-comm-msg-av { width:14px; height:14px; }
  .wd-comm-msg { gap:1px; }
}

/* ---- Clan management drill-in (reuses .wd-tpl-detail / .wd-kv* / .wd-list) ---- */
.wd-clan-head { display:flex; flex-direction:column; gap:4px; }
.wd-clan-via { font-size:10px; color:var(--sub); align-self:center; }
.wd-clan-desc { font-size:11px; color:var(--sub); word-break:break-word; }
/* Roster rows: avatar + name/badge + inline role select & kick. */
.wd-clan-member .wd-clan-av { border-radius:50%; object-fit:cover; }
.wd-clan-mctl { display:flex; align-items:center; gap:4px; flex:none; }
.wd-clan-role { font:10px "MS Sans Serif",sans-serif; }
/* Invites: mono code + meta. */
.wd-clan-code { font:11px monospace; user-select:all; }
.wd-clan-imeta { font-size:10px; color:var(--sub); white-space:nowrap; }
/* Applications: applicant + optional message. */
.wd-clan-app { align-items:flex-start; }
.wd-clan-appwho { font-weight:bold; }
.wd-clan-appmsg { font-size:10px; color:var(--sub); white-space:pre-wrap; word-break:break-word; }
/* Settings form fields. */
.wd-clan-fld { display:flex; flex-direction:column; gap:2px; font-size:10px; color:var(--sub); margin-bottom:5px; }
.wd-clan-fld > input, .wd-clan-fld > textarea, .wd-clan-fld > select { font:11px "MS Sans Serif",Tahoma,sans-serif; width:100%; box-sizing:border-box; }
.wd-clan-chk { display:flex; align-items:center; gap:5px; font-size:11px; margin-bottom:5px; }
/* Trailing action row (Load more / Save / Create invite). */
.wd-clan-more { margin-top:5px; }
.wd-clan-danger { display:flex; gap:6px; flex-wrap:wrap; }
/* ---- Community browse + create-clan chooser (reuses .wd-list/.wd-row/.wd-clan-fld) ---- */
.wd-comm-browse { display:flex; flex-direction:column; gap:6px; }
.wd-comm-br-bar { display:flex; align-items:center; gap:6px; }
.wd-comm-br-search { flex:1; min-width:0; font:11px "MS Sans Serif",Tahoma,sans-serif; box-sizing:border-box; }
.wd-comm-br-row { cursor:pointer; }
.wd-comm-br-row:hover .wd-clancard { background:var(--group); }
.wd-comm-br-foot { display:flex; align-items:center; gap:6px; padding:4px 0 2px; }
.wd-comm-br-name { font-weight:bold; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.wd-comm-br-tag { color:var(--sub); font-weight:normal; }
.wd-comm-br-meta { font-size:10px; color:var(--sub); }
.wd-comm-br-chooser { display:flex; flex-direction:column; gap:8px; }
.wd-comm-br-note { font-size:11px; color:var(--txt); margin-bottom:4px; }
.wd-comm-br-muted { color:var(--sub); }
.wd-comm-br-suggest { font-size:12px; font-weight:bold; margin-bottom:4px; }
/* ---- Advanced clan card (banner + overlaid avatar + stat chips; Hub full / browse compact) ---- */
.wd-clancard { position:relative; border:2px solid; border-color:var(--dark) var(--light) var(--light) var(--dark); background:var(--field); overflow:hidden; }
.wd-clancard-banner { height:56px; background-size:cover; background-position:center; background-color:var(--group); }
.wd-clancard--compact .wd-clancard-banner { height:34px; }
.wd-clancard-av { position:absolute; left:8px; top:34px; border:2px solid var(--field); background:var(--group); }
.wd-clancard--compact .wd-clancard-av { top:16px; width:32px; height:32px; }
.wd-clancard-body { padding:8px 8px 8px 56px; }
.wd-clancard-name { font-weight:bold; font-size:12px; display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.wd-clancard-tag { color:var(--sub); font-weight:normal; }
.wd-clancard-chips { display:flex; gap:6px; flex-wrap:wrap; margin-top:4px; font-size:10px; color:var(--sub); }
.wd-clancard-chip { white-space:nowrap; }
`;
}
