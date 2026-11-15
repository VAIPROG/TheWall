// Shared chrome for the landing site. i18n lives in /assets/i18n.js.
(function () {
  const THEME_KEY = "wall_landing_theme";

  // ---- Win95 icon library ------------------------------------------------
  // Inline SVG replacements for the OS emoji glyphs. Same flavour as the
  // extension's src/icons.ts: 16×16 viewBox, fill:currentColor, crispEdges.
  // Usage: static HTML `<span class="ic" data-icon="shield"></span>` gets
  // hydrated on DOMContentLoaded; JS-generated markup calls wd.icon("name").
  const ICONS = {
    // community / features
    community: '<rect x="1" y="13" width="14" height="2"/><rect x="2.5" y="6" width="2" height="6"/><rect x="7" y="6" width="2" height="6"/><rect x="11.5" y="6" width="2" height="6"/><path d="M8 0.5L15 5H1z"/>',
    ruler: '<path d="M2 14L14 2v12z"/><path d="M6.5 13.5v-2M9 13.5v-3.2M11.5 13.5v-2" stroke="#fff" stroke-width="1.2"/>',
    image: '<rect x="1" y="2" width="14" height="12" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="4" y="4.5" width="3" height="3"/><path d="M2.5 12.5l3.5-4 3 3 2-2 2.5 2.5v.5z"/>',
    shield: '<path d="M8 1l6 2v5c0 4-3 6-6 7-3-1-6-3-6-7V3z"/><path d="M5 8l2 2 4-4" fill="none" stroke="#fff" stroke-width="1.6"/>',
    alert: '<path d="M4.5 8a3.5 3.5 0 0 1 7 0v4h-7z"/><rect x="2" y="12" width="12" height="2.4"/><rect x="7.2" y="0.5" width="1.6" height="2.4"/><path d="M2.4 3.6l2 1.6M13.6 3.6l-2 1.6" stroke="currentColor" stroke-width="1.5"/>',
    camera: '<rect x="1" y="4" width="14" height="10"/><rect x="5" y="2" width="6" height="2.4"/><circle cx="8" cy="9" r="3.2" fill="#fff"/><circle cx="8" cy="9" r="1.6"/>',
    user: '<circle cx="8" cy="5" r="3.2"/><path d="M2 15c0-4 3-6 6-6s6 2 6 6z"/>',
    robot: '<rect x="3" y="5" width="10" height="8"/><rect x="7.2" y="2.6" width="1.6" height="2.6"/><rect x="6.8" y="1" width="2.4" height="2"/><rect x="5" y="7" width="2" height="2" fill="#fff"/><rect x="9" y="7" width="2" height="2" fill="#fff"/><rect x="5" y="10.6" width="6" height="1.2" fill="#fff"/><rect x="0.8" y="7" width="1.6" height="4"/><rect x="13.6" y="7" width="1.6" height="4"/>',
    trophy: '<path d="M4 1h8v5a4 4 0 0 1-8 0z"/><path d="M1.5 2H4v3.6A3 3 0 0 1 1.5 2.9zM14.5 2H12v3.6a3 3 0 0 0 2.5-2.7z"/><rect x="7" y="9.5" width="2" height="3"/><rect x="4" y="12.5" width="8" height="2"/>',
    moon: '<path d="M13.6 10.4A6.4 6.4 0 0 1 5.6 2.4 6.4 6.4 0 1 0 13.6 10.4z"/>',
    sun: '<circle cx="8" cy="8" r="3.4"/><path d="M8 0v2.6M8 13.4V16M0 8h2.6M13.4 8H16M2.2 2.2l1.9 1.9M11.9 11.9l1.9 1.9M13.8 2.2l-1.9 1.9M4.1 11.9l-1.9 1.9" stroke="currentColor" stroke-width="1.6"/>',
    link: '<rect x="0.6" y="6" width="8" height="4" rx="2" fill="none" stroke="currentColor" stroke-width="1.7" transform="rotate(-45 4.6 8)"/><rect x="7.4" y="6" width="8" height="4" rx="2" fill="none" stroke="currentColor" stroke-width="1.7" transform="rotate(-45 11.4 8)"/>',
    // messaging / accounts
    mailbox: '<rect x="1" y="6" width="9" height="7"/><path d="M10 6a4 4 0 0 1 5 3.9V13h-5z"/><rect x="4.5" y="13" width="2" height="2.5"/><rect x="3.5" y="1" width="1.4" height="5"/><path d="M4.9 1h4.2L7.9 2.7l1.2 1.7H4.9z"/>',
    mail: '<rect x="1" y="3" width="14" height="10"/><path d="M2 4l6 5 6-5" fill="none" stroke="#fff" stroke-width="1.5"/>',
    chat: '<rect x="1" y="2" width="14" height="9"/><rect x="3" y="4" width="10" height="1.6" fill="#fff"/><rect x="3" y="7" width="7" height="1.6" fill="#fff"/><path d="M4 11l0 3 3-3z"/>',
    plane: '<path d="M1 8l14-6-6 14-2-5z"/><path d="M9 7l-4 3" stroke="#fff" stroke-width="1"/>',
    antenna: '<path d="M2 1.5A12.5 12.5 0 0 1 14.5 14h-2.2A10.3 10.3 0 0 0 2 3.7z"/><path d="M2 6a8 8 0 0 1 8 8H7.8A5.8 5.8 0 0 0 2 8.2z"/><circle cx="3.4" cy="12.6" r="1.8"/>',
    gamepad: '<path d="M3 5h10l2 6.2a1.9 1.9 0 0 1-3.4 1L10.4 10H5.6l-1.2 2.2a1.9 1.9 0 0 1-3.4-1z"/><rect x="4" y="6.8" width="3.4" height="1.4" fill="#fff"/><rect x="5" y="5.8" width="1.4" height="3.4" fill="#fff"/><circle cx="11" cy="6.8" r="0.9" fill="#fff"/><circle cx="12.6" cy="8.4" r="0.9" fill="#fff"/>',
    // objects
    trash: '<rect x="3" y="4" width="10" height="11"/><rect x="5" y="6" width="1.5" height="7" fill="#fff"/><rect x="9.5" y="6" width="1.5" height="7" fill="#fff"/><rect x="2" y="2" width="12" height="2"/><rect x="6" y="0" width="4" height="2"/>',
    pin: '<path d="M8 1c3 0 5 2 5 5 0 4-5 9-5 9S3 10 3 6c0-3 2-5 5-5z"/><circle cx="8" cy="6" r="2" fill="#fff"/>',
    book: '<path d="M1 2.4c2.2-1 5-.8 7 .8 2-1.6 4.8-1.8 7-.8v11c-2.2-1-5-.8-7 .8-2-1.6-4.8-1.8-7-.8z"/><path d="M8 3.4v10.4" stroke="#fff" stroke-width="1.2"/>',
    page: '<path d="M3 1h7l3 3v11H3z"/><path d="M10 1v3h3z" fill="#fff"/><rect x="5" y="7" width="6" height="1.2" fill="#fff"/><rect x="5" y="9.8" width="6" height="1.2" fill="#fff"/><rect x="5" y="12.6" width="4" height="1.2" fill="#fff"/>',
    doll: '<path d="M8 1c1.8 0 3 1.3 3 3 0 .8-.3 1.6-.8 2.2C12.2 7.5 13.2 9.4 13.2 11c0 2.9-2.3 4-5.2 4S2.8 13.9 2.8 11c0-1.6 1-3.5 3-4.8C5.3 5.6 5 4.8 5 4c0-1.7 1.2-3 3-3z"/><circle cx="8" cy="4.2" r="1.5" fill="#fff"/><path d="M5.4 10.5c1.6-1.4 3.6-1.4 5.2 0" fill="none" stroke="#fff" stroke-width="1.2"/>',
    rice: '<path d="M3.2 7.6c-.7-4.2 10.3-4.2 9.6 0z"/><path d="M1 8h14c0 3-1.9 5-4 6H5c-2.1-1-4-3-4-6z"/><path d="M3.5 11h9" stroke="#fff" stroke-width="1.1"/>',
    brick: '<rect x="1" y="3" width="14" height="10" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M1 6.3h14M1 9.6h14M5.5 3v3.3M10.5 3v3.3M8 6.3v3.3M4 9.6V13M12 9.6V13" stroke="currentColor" stroke-width="1.1"/>',
    hourglass: '<rect x="3" y="1" width="10" height="2"/><rect x="3" y="13" width="10" height="2"/><path d="M4 3h8l-4 5z"/><path d="M4 13h8l-4-5z"/>',
    star: '<path d="M8 1l2 4.6 5 .5-3.8 3.3L12.4 14 8 11.4 3.6 14l1.2-4.6L1 6.1l5-.5z"/>',
    pencil: '<path d="M2 14l1-4 8-8 3 3-8 8z"/><path d="M10.2 2.8l3 3" stroke="#fff" stroke-width="1.2"/>',
    // sound
    speaker: '<path d="M2 6h3l4-4v12l-4-4H2z"/><path d="M11 5.2a4 4 0 0 1 0 5.6" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    mute: '<path d="M2 6h3l4-4v12l-4-4H2z"/><path d="M10.5 6l4 4M14.5 6l-4 4" stroke="currentColor" stroke-width="1.6"/>',
    // leaderboard medals — colour comes from CSS (.medal-1/-2/-3)
    medal1: '<path d="M5 1h6l-1.4 4H6.4z"/><circle cx="8" cy="10" r="5"/><path d="M7 8.2l1.4-1.2h.6V13H7.6V9l-.9.6z" fill="#fff"/>',
    medal2: '<path d="M5 1h6l-1.4 4H6.4z"/><circle cx="8" cy="10" r="5"/><path d="M6 8.8c.2-1.2 1-1.8 2-1.8 1.2 0 2 .7 2 1.8 0 .8-.5 1.4-1.3 2.1l-1 .9H10V13H6v-1.1l1.9-1.8c.6-.6.8-.9.8-1.3 0-.4-.3-.7-.7-.7-.5 0-.7.3-.8.8z" fill="#fff"/>',
    medal3: '<path d="M5 1h6l-1.4 4H6.4z"/><circle cx="8" cy="10" r="5"/><path d="M6.1 8.6C6.3 7.6 7 7 8.1 7c1.1 0 1.9.6 1.9 1.5 0 .6-.3 1-.8 1.3.6.3 1 .8 1 1.5 0 1-.9 1.7-2.1 1.7-1.2 0-1.9-.6-2.1-1.6l1.2-.3c.1.5.4.7.9.7s.8-.2.8-.6c0-.4-.3-.6-.9-.6h-.5v-1h.5c.5 0 .8-.2.8-.6 0-.3-.3-.5-.7-.5s-.7.2-.8.7z" fill="#fff"/>',
  };

  function icon(name, cls) {
    const body = ICONS[name];
    if (!body) return "";
    return (
      '<svg class="wd-svg' + (cls ? " " + cls : "") +
      '" viewBox="0 0 16 16" fill="currentColor" shape-rendering="crispEdges"' +
      ' aria-hidden="true" focusable="false">' + body + "</svg>"
    );
  }

  function hydrateIcons(root) {
    (root || document).querySelectorAll("[data-icon]").forEach((el) => {
      el.innerHTML = icon(el.dataset.icon);
    });
  }

  // ---- nav config -------------------------------------------------------
  // public[] is always rendered; auth[] is appended after we detect the user
  // is signed in (Wall JWT in walldev_cfg or VAI JWT in wall_vai_jwt).
  const NAV_PUBLIC = [
    { page: "index",        href: "/",                 i18n: "nav.home" },
    { page: "about",        href: "/about.html",       i18n: "nav.about" },
    { page: "docs",         href: "/docs.html",        i18n: "nav.docs" },
    { page: "feed",         href: "/feed.html",        i18n: "nav.feed" },
    { page: "achievements", href: "/achievements.html",i18n: "nav.achievements" },
    { page: "changelog",    href: "/changelog.html",   i18n: "nav.changelog" },
    { page: "api-docs",     href: "/api-docs/",        i18n: "nav.api_docs" },
    { page: "privacy",      href: "/privacy.html",     i18n: "nav.privacy" },
    { page: "vai-auth",     href: "/vai-auth.html",    i18n: "nav.vai_auth" },
  ];
  const NAV_AUTH = [
    { page: "dashboard", href: "/dashboard.html", i18n: "nav.dashboard" },
    { page: "me",        href: "/me.html",        i18n: "nav.me" },
  ];

  function setTheme(t) {
    if (t !== "dark" && t !== "light") t = "light";
    document.body.classList.toggle("dark", t === "dark");
    document.querySelectorAll(".theme-sw span").forEach((s) =>
      s.classList.toggle("active", s.dataset.theme === t),
    );
    localStorage.setItem(THEME_KEY, t);
  }

  window.wd = Object.assign(window.wd || {}, { setTheme, icon, hydrateIcons });

  // ---- chrome render ----------------------------------------------------

  function isSignedIn() {
    try {
      const cfg = localStorage.getItem("walldev_cfg");
      if (cfg && JSON.parse(cfg).backendToken) return true;
    } catch {}
    if (localStorage.getItem("wall_vai_jwt")) return true;
    if (localStorage.getItem("wall_landing_jwt")) return true;
    return false;
  }

  function renderChrome() {
    const root = document.getElementById("chrome-root");
    if (!root) return;
    const all = [...NAV_PUBLIC];
    if (isSignedIn()) all.push(...NAV_AUTH);
    const links = all
      .map((n) => `<a href="${n.href}" data-page="${n.page}"><span data-i18n="${n.i18n}">${n.page}</span></a>`)
      .join("");
    root.innerHTML = `
      <div class="menubar">
        <span class="logo">
          <img src="/assets/botAvatar.svg" alt="" width="16" height="16" style="vertical-align:-3px;margin-right:4px;border-radius:50%">
          The Wall Dev
        </span>
        ${links}
        <span class="spacer"></span>
        <span class="theme-sw" title="Theme">
          <span data-theme="light" onclick="wd.setTheme('light')" role="button" aria-label="Light theme">${icon("sun")}</span>
          <span data-theme="dark"  onclick="wd.setTheme('dark')" role="button" aria-label="Dark theme">${icon("moon")}</span>
        </span>
        <span class="lang-sw" title="Language">
          <span data-lang-btn="en" onclick="wd.setLang('en')">EN</span>
          <span data-lang-btn="ru" onclick="wd.setLang('ru')">RU</span>
          <span data-lang-btn="de" onclick="wd.setLang('de')">DE</span>
          <span data-lang-btn="fr" onclick="wd.setLang('fr')">FR</span>
        </span>
      </div>
    `;
  }

  function renderFooter() {
    const f = document.getElementById("footer-root");
    if (!f) return;
    f.innerHTML = `
      <footer>
        <p>
          <a href="https://vai-rice.space" target="_blank">vai-rice.space</a> ·
          <a href="https://snackers.vai-rice.space" target="_blank">SnackersWiki</a> ·
          <a href="https://discord.gg/filian" target="_blank">Snackers Discord</a> ·
          <a href="https://discord.gg/snackersru" target="_blank">SnackersRU</a>
        </p>
        <p style="margin-top:4px">
          <a href="https://x.com/VAI_PROG"     target="_blank">x.com/VAI_PROG</a> ·
          <a href="https://github.com/VAIPROG" target="_blank">GitHub</a> ·
          <a href="mailto:vadim+the_wall@vai-rice.space" data-i18n="footer.contact">contact</a>
        </p>
        <p style="margin-top:6px;opacity:.85"><span data-i18n-html="footer.made_by"></span></p>
        <p style="opacity:.6" id="footer-version">The Wall Dev</p>
      </footer>
    `;
    // Pull live versions from /api/meta — no-op if backend offline.
    fetch("/api/meta", { cache: "no-store" }).then(r => r.ok ? r.json() : null).then(m => {
      if (!m) return;
      const el = document.getElementById("footer-version");
      const ext = m.extension_version || "v4";
      const back = "v" + (m.version || "?");
      if (el) el.textContent = `Extension ${ext} · Backend ${back}`;
    }).catch(() => {});
  }

  document.addEventListener("DOMContentLoaded", async () => {
    renderChrome();
    renderFooter();
    hydrateIcons();

    if (window.wd && window.wd.setLang) {
      await window.wd.setLang(window.wd.initialLang ? window.wd.initialLang() : "en");
    }

    const savedTheme = localStorage.getItem(THEME_KEY) ||
      (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    setTheme(savedTheme);

    const path = location.pathname.replace(/\/+$/, "").split("/").pop() || "index";
    document.querySelectorAll(".menubar a[data-page]").forEach((a) => {
      a.classList.toggle("active",
        a.dataset.page === path ||
        (path === "index" && a.dataset.page === "home") ||
        (path === "" && a.dataset.page === "index"));
    });
  });
})();
