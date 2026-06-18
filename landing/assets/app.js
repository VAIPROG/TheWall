// Shared chrome for the landing site. i18n lives in /assets/i18n.js.
(function () {
  const THEME_KEY = "wall_landing_theme";

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

  window.wd = Object.assign(window.wd || {}, { setTheme });

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
          <span data-theme="light" onclick="wd.setTheme('light')">☀</span>
          <span data-theme="dark"  onclick="wd.setTheme('dark')">☾</span>
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
          <a href="https://x.com/VAI_PROG"     target="_blank">x.com/VAI_PROG</a> ·
          <a href="https://github.com/Vadim-Khristenko" target="_blank">GitHub</a> ·
          <a href="https://discord.gg/snackersru" target="_blank">Snackers RU Discord</a> ·
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
