// Shared structured i18n loader for the landing site.
//
// Model:
//   - One JSON file per locale at /assets/i18n/<lang>.json
//   - Page-specific JSON can be declared via <meta name="page-i18n" content="docs">
//   - Elements with data-i18n/data-i18n-html/data-i18n-placeholder/data-i18n-title
//     are translated from dot-path keys.
(function () {
  const LANG_KEY = "wall_landing_lang";
  const I18N_VER = "20260607a";
  const SUPPORTED = ["en", "ru", "de", "fr"];

  const I18N = { dict: {}, lang: "en" };

  function get(path) {
    return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), I18N.dict);
  }

  function fmt(s, vars) {
    return s.replace(/\{(\w+)\}/g, (_, k) => vars && k in vars ? vars[k] : "{" + k + "}");
  }

  window.wd_t = function (key, vars) {
    const v = get(key);
    if (v == null) return key;
    return vars ? fmt(String(v), vars) : String(v);
  };
  window.wd_raw = function (key) { return get(key); };

  async function fetchJson(path) {
    const r = await fetch(path + "?v=" + I18N_VER, { cache: "force-cache" });
    if (!r.ok) throw new Error("status " + r.status);
    return r.json();
  }

  async function loadLocale(lang) {
    const cacheKey = "wall_landing_i18n_" + lang + "_" + I18N_VER;
    const cached = localStorage.getItem(cacheKey);
    if (cached) { try { return JSON.parse(cached); } catch {} }
    try {
      const j = await fetchJson("/assets/i18n/" + lang + ".json");
      try { localStorage.setItem(cacheKey, JSON.stringify(j)); } catch {}
      return j;
    } catch (e) {
      if (lang !== "en") return loadLocale("en");
      console.error("i18n load failed", e);
      return {};
    }
  }

  async function loadPageLocale(page, lang) {
    const cacheKey = "wall_landing_i18n_" + page + "_" + lang + "_" + I18N_VER;
    const cached = localStorage.getItem(cacheKey);
    if (cached) { try { return JSON.parse(cached); } catch {} }
    try {
      const j = await fetchJson("/assets/i18n/" + page + "/" + lang + ".json");
      try { localStorage.setItem(cacheKey, JSON.stringify(j)); } catch {}
      return j;
    } catch (e) {
      if (lang !== "en") return loadPageLocale(page, "en");
      return null;
    }
  }

  function applyI18n() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const v = get(el.dataset.i18n);
      if (v != null) el.textContent = String(v);
    });
    document.querySelectorAll("[data-i18n-html]").forEach((el) => {
      const v = get(el.dataset.i18nHtml);
      if (v != null) el.innerHTML = String(v);
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      const v = get(el.dataset.i18nPlaceholder);
      if (v != null) el.setAttribute("placeholder", String(v));
    });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      const v = get(el.dataset.i18nTitle);
      if (v != null) el.setAttribute("title", String(v));
    });

    document.body.classList.remove("lang-en", "lang-ru", "lang-de", "lang-fr");
    document.body.classList.add("lang-" + I18N.lang);
    document.documentElement.lang = I18N.lang;
  }

  async function setLang(l) {
    if (!SUPPORTED.includes(l)) l = "en";
    I18N.lang = l;
    I18N.dict = await loadLocale(l);

    const pageMeta = document.querySelector('meta[name="page-i18n"]');
    if (pageMeta) {
      const pageDict = await loadPageLocale(pageMeta.content, l);
      if (pageDict) I18N.dict.page = pageDict;
    }

    localStorage.setItem(LANG_KEY, l);
    applyI18n();
    document.querySelectorAll(".lang-sw span").forEach((s) =>
      s.classList.toggle("active", s.dataset.langBtn === l),
    );
    document.dispatchEvent(new CustomEvent("wd:lang-changed", { detail: { lang: l } }));
  }

  function initialLang() {
    const savedLang = localStorage.getItem(LANG_KEY) ||
      (navigator.language || "en").slice(0, 2).toLowerCase();
    return SUPPORTED.includes(savedLang) ? savedLang : "en";
  }

  window.wd = Object.assign(window.wd || {}, { setLang, initialLang });
})();
