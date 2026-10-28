const LEADS_KEY = "leads";
const CAPTURING_KEY = "capturing";
const FILTERS_KEY = "filters";
const LOG_KEY = "log";
const CAPTURE_ALL_KEY = "verifying";
const OPEN_CARDS_KEY = "autoComplete";

const t = (key, ...args) => (chrome.i18n.getMessage(key) || key).replace(/\{(\d)\}/g, (_, i) => args[i] ?? "");
const LOCALE = chrome.i18n.getUILanguage();

const TYPE_LABEL = {
  none: "typeNone",
  social: "typeSocial",
  unverified: "typeUnverified",
  own: "typeOwn",
};

const COLUMNS = [
  ["score", "csvScore"],
  ["name", "csvName"],
  ["category", "csvCategory"],
  ["phone", "csvPhone"],
  ["address", "csvAddress"],
  ["rating", "csvRating"],
  ["reviews", "csvReviews"],
  ["siteType", "csvSiteType"],
  ["verified", "csvVerified"],
  ["site", "csvWebsite"],
  ["hours", "csvHours"],
  ["lat", "csvLat"],
  ["lng", "csvLng"],
  ["query", "csvQuery"],
  ["mapsUrl", "csvMapsUrl"],
  ["capturedAt", "csvCapturedAt"],
];

const $ = (id) => document.getElementById(id);
const state = {
  leads: {},
  log: [],
  capturing: true,
  captureAll: false,
  openCards: false,
  filters: { type: "nosite", minReviews: 0, minScore: 0 },
  lastLogT: 0,
  openId: null,
};

// ---- static text ----

document.documentElement.lang = LOCALE;
document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
document.querySelectorAll("[data-i18n-title]").forEach((el) => (el.title = t(el.dataset.i18nTitle)));
document.querySelectorAll("[data-i18n-aria]").forEach((el) => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
$("version").textContent = "v" + chrome.runtime.getManifest().version;

// ---- filters and CSV ----

function applyFilters(list, f) {
  return list
    .filter((l) => {
      if (f.type === "nosite" && !["none", "social"].includes(l.siteType)) return false;
      if (f.type === "none" && l.siteType !== "none") return false;
      if ((l.reviews || 0) < f.minReviews) return false;
      if ((l.score || 0) < f.minScore) return false;
      return true;
    })
    .sort((a, b) => b.score - a.score);
}

// Excel follows the system locale: where the decimal mark is a comma it expects ";"
const DECIMAL = (1.5).toLocaleString(LOCALE).charAt(1);
const SEPARATOR = DECIMAL === "," ? ";" : ",";

function toCSV(rows) {
  const esc = (v, key) => {
    if (v === null || v === undefined) return "";
    if (typeof v === "boolean") v = t(v ? "yes" : "no");
    else if (key === "siteType") v = t(TYPE_LABEL[v] || v);
    let s = typeof v === "number" ? String(v).replace(".", DECIMAL) : String(v);
    if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula injection
    return s.includes(SEPARATOR) || /["\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = COLUMNS.map(([, label]) => t(label)).join(SEPARATOR);
  const body = rows.map((r) => COLUMNS.map(([k]) => esc(r[k], k)).join(SEPARATOR));
  return "﻿" + [header, ...body].join("\r\n"); // BOM so Excel reads UTF-8
}

function download(text, filename) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- helpers ----

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

const scoreClass = (s) => (s >= 70 ? "hi" : s >= 40 ? "mid" : "lo");
const fmtRating = (n) => (n ? `${n.toLocaleString(LOCALE)}★` : null);

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}min` : `${Math.round(m / 60)}h`;
}

function findLead(id, name) {
  return state.leads[id] || Object.values(state.leads).find((l) => l.name === name);
}

function buildRow(lead, { metaParts = [], right }) {
  const btn = el("button", "row");
  btn.type = "button";
  btn.title = t("viewDetails");
  btn.addEventListener("click", () => openSheet(lead.id));
  btn.append(el("span", "name", lead.name));
  const meta = el("span", "meta");
  metaParts.filter(Boolean).forEach((p) => meta.append(typeof p === "string" ? el("span", "", p) : p));
  btn.append(meta);
  const side = el("span", "side");
  right.forEach((r) => side.append(r));
  side.append(el("span", `tag tag--${lead.siteType}`, t(TYPE_LABEL[lead.siteType] || lead.siteType)));
  btn.append(side);
  return btn;
}

// text with {0} {1} placeholders rendered as bold numbers
function withBold(key, ...nums) {
  const parts = (chrome.i18n.getMessage(key) || key).split(/\{(\d)\}/);
  return parts.map((p, i) => (i % 2 ? el("b", "", nums[p]) : p));
}

// ---- render ----

function renderSummary() {
  const all = Object.values(state.leads);
  const c = { none: 0, social: 0, unverified: 0, own: 0 };
  all.forEach((l) => (c[l.siteType] = (c[l.siteType] || 0) + 1));
  const total = all.length;

  $("s-total").textContent = total;
  $("s-none").textContent = c.none;
  $("s-social").textContent = c.social;
  $("s-unknown").textContent = c.unverified;
  $("s-site").textContent = c.own;
  [c.none, c.social, c.unverified, c.own].forEach((n, i) => {
    $("bar").children[i].style.width = total ? `${(n / total) * 100}%` : "0";
  });

  $("auto").checked = state.openCards;
  const vb = $("verify");
  vb.textContent = t(state.captureAll ? "actionStop" : "actionCaptureAll");
  vb.className = `btn btn--sm ${state.captureAll ? "btn--stop" : "btn--primary"}`;

  const st = $("toggle");
  st.className = `status ${!state.capturing ? "paused" : state.captureAll ? "verifying" : ""}`;
  $("toggle-label").textContent = t(!state.capturing ? "statusPaused" : state.captureAll ? "statusCapturingAll" : "statusCapturing");
  st.title = t(state.capturing ? "pauseCapture" : "resumeCapture");
}

function renderFeed() {
  const feed = $("feed");
  feed.innerHTML = "";
  const newest = state.log[0]?.t || 0;
  state.log.slice(0, 50).forEach((e) => {
    const lead = findLead(e.id, e.name) || { ...e };
    const view = { ...lead, siteType: e.siteType, score: e.score };
    const row = buildRow(view, {
      metaParts: [
        el("span", `score ${scoreClass(e.score)}`, e.score),
        t(e.action === "verified" ? "feedVerified" : "feedCaptured"),
        e.category,
      ],
      right: [el("span", "time", ago(e.t))],
    });
    if (state.lastLogT && e.t > state.lastLogT) row.classList.add("fresh");
    const li = el("li");
    li.append(row);
    feed.append(li);
  });
  state.lastLogT = newest;
  $("feed-empty").hidden = state.log.length > 0;
  const recent = state.log.filter((e) => Date.now() - e.t < 60000).length;
  $("c-live").textContent = recent ? `+${recent}` : "";
}

function renderBest() {
  const list = applyFilters(Object.values(state.leads), state.filters).slice(0, 30);
  const rank = $("rank");
  rank.innerHTML = "";
  list.forEach((l, i) => {
    const row = buildRow(l, {
      metaParts: [fmtRating(l.rating), l.reviews ? t("reviewsShort", l.reviews) : null, l.category],
      right: [el("span", `score ${scoreClass(l.score)}`, l.score)],
    });
    row.prepend(el("span", "pos", String(i + 1).padStart(2, "0")));
    const li = el("li");
    li.append(row);
    rank.append(li);
  });
  $("rank-empty").hidden = list.length > 0;
}

function renderExport() {
  const all = Object.values(state.leads);
  const n = applyFilters(all, state.filters).length;
  const f = state.filters;
  [...$("f-type").children].forEach((b) => b.classList.toggle("on", b.dataset.value === f.type));
  $("f-reviews").value = f.minReviews;
  $("f-score").value = f.minScore;
  $("o-reviews").textContent = f.minReviews;
  $("o-score").textContent = f.minScore;
  const hint = $("hint");
  hint.innerHTML = "";
  if (all.length) hint.append(...withBold("exportHint", n, all.length));
  else hint.textContent = t("noLeadsYet");
  $("export").disabled = n === 0;
  $("clear").disabled = all.length === 0;
}

// ---- detail sheet ----

function mapsLinks(l) {
  const hasCoords = l.lat != null && l.lng != null;
  const q = hasCoords ? `${l.lat},${l.lng}` : `${l.name} ${l.address || ""}`;
  return {
    embed: `https://maps.google.com/maps?q=${encodeURIComponent(q)}&z=16&output=embed`,
    route: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}`,
    hasQuery: hasCoords || !!l.address,
  };
}

function infoRow(label, value, { href, copy, empty = t("notProvided") } = {}) {
  const wrap = el("div");
  wrap.append(el("dt", "", label));
  const dd = el("dd");
  if (!value) {
    dd.append(el("span", "muted", empty));
  } else if (href) {
    const a = el("a", "", value);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    dd.append(a);
  } else {
    dd.append(el("span", "", value));
  }
  if (value && copy) {
    const b = el("button", "copy", t("copy"));
    b.type = "button";
    b.addEventListener("click", async () => {
      await navigator.clipboard.writeText(copy);
      b.textContent = t("copied");
      b.classList.add("done");
      setTimeout(() => {
        b.textContent = t("copy");
        b.classList.remove("done");
      }, 1500);
    });
    dd.append(b);
  }
  wrap.append(dd);
  return wrap;
}

let lastMapKey = "";
function renderSheet() {
  const l = state.openId && state.leads[state.openId];
  if (!l) return;

  const links = mapsLinks(l);
  const map = $("d-map");
  if (links.embed !== lastMapKey) {
    map.innerHTML = "";
    if (links.hasQuery) {
      const f = document.createElement("iframe");
      f.src = links.embed;
      f.loading = "lazy";
      f.referrerPolicy = "no-referrer-when-downgrade";
      f.title = t("mapOf", l.name);
      map.append(f);
    } else {
      map.append(el("div", "nomap", t("noLocation")));
    }
    lastMapKey = links.embed;
  }

  $("d-name").textContent = l.name;
  $("d-sub").textContent = [l.category, fmtRating(l.rating), l.reviews ? t("reviewsLong", l.reviews) : null].filter(Boolean).join(" · ");
  $("d-score").textContent = l.score;
  $("d-score").className = `score ${scoreClass(l.score)}`;
  const tag = $("d-tag");
  tag.className = `tag tag--${l.siteType}`;
  tag.textContent = t(TYPE_LABEL[l.siteType] || l.siteType);

  const info = $("d-info");
  info.innerHTML = "";
  const phoneDigits = (l.phone || "").replace(/\D/g, "");
  info.append(
    infoRow(t("fieldAddress"), l.address, { copy: l.address }),
    infoRow(t("fieldPhone"), l.phone, { href: phoneDigits ? `tel:${phoneDigits}` : null, copy: l.phone }),
    infoRow(t("fieldWebsite"), l.site ? l.site.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") : null, {
      href: l.site || null,
      empty: t(l.verified ? "noWebsite" : "notVerified"),
    }),
    infoRow(t("fieldHours"), l.hours),
    infoRow(t("fieldQuery"), l.query),
    infoRow(t("fieldCaptured"), l.capturedAt ? new Date(l.capturedAt).toLocaleString(LOCALE, { dateStyle: "short", timeStyle: "short" }) : null)
  );

  $("d-open").href = l.mapsUrl;
  $("d-route").href = links.route;
}

function openSheet(id) {
  if (!state.leads[id]) return;
  state.openId = id;
  lastMapKey = "";
  renderSheet();
  $("sheet").hidden = false;
}

function closeSheet() {
  state.openId = null;
  $("sheet").hidden = true;
  $("d-map").innerHTML = "";
  lastMapKey = "";
}

$("sheet-back").addEventListener("click", closeSheet);
document.addEventListener("keydown", (e) => e.key === "Escape" && !$("sheet").hidden && closeSheet());

function renderAll() {
  renderSummary();
  renderFeed();
  renderBest();
  renderExport();
  if (state.openId) renderSheet();
}

// ---- events ----

document.querySelectorAll(".tabs button").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", b === tab));
    document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
  })
);

function saveFilters() {
  chrome.storage.local.set({ [FILTERS_KEY]: state.filters });
  renderBest();
  renderExport();
}

$("f-type").addEventListener("click", (e) => {
  const v = e.target.closest("button")?.dataset.value;
  if (!v) return;
  state.filters.type = v;
  saveFilters();
});
$("f-reviews").addEventListener("input", (e) => {
  state.filters.minReviews = Number(e.target.value);
  saveFilters();
});
$("f-score").addEventListener("input", (e) => {
  state.filters.minScore = Number(e.target.value);
  saveFilters();
});

$("auto").addEventListener("change", (e) => chrome.storage.local.set({ [OPEN_CARDS_KEY]: e.target.checked }));
$("verify").addEventListener("click", () => chrome.storage.local.set({ [CAPTURE_ALL_KEY]: !state.captureAll }));
$("toggle").addEventListener("click", () => chrome.storage.local.set({ [CAPTURING_KEY]: !state.capturing }));

$("export").addEventListener("click", () => {
  const rows = applyFilters(Object.values(state.leads), state.filters);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
  download(toCSV(rows), `prospecta-leads-${stamp}.csv`);
});

$("clear").addEventListener("click", () => {
  const n = Object.keys(state.leads).length;
  if (confirm(t("clearConfirm", n))) {
    closeSheet();
    chrome.storage.local.set({ [LEADS_KEY]: {}, [LOG_KEY]: [], clearedAt: Date.now() });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[LEADS_KEY]) state.leads = changes[LEADS_KEY].newValue || {};
  if (changes[LOG_KEY]) state.log = changes[LOG_KEY].newValue || [];
  if (changes[CAPTURING_KEY]) state.capturing = changes[CAPTURING_KEY].newValue !== false;
  if (changes[CAPTURE_ALL_KEY]) state.captureAll = changes[CAPTURE_ALL_KEY].newValue === true;
  if (changes[OPEN_CARDS_KEY]) state.openCards = changes[OPEN_CARDS_KEY].newValue === true;
  if (changes[FILTERS_KEY]?.newValue) state.filters = { ...state.filters, ...changes[FILTERS_KEY].newValue };
  renderAll();
});

setInterval(renderFeed, 5000);

(async function init() {
  const data = await chrome.storage.local.get([LEADS_KEY, CAPTURING_KEY, FILTERS_KEY, LOG_KEY, CAPTURE_ALL_KEY, OPEN_CARDS_KEY]);
  state.leads = data[LEADS_KEY] || {};
  state.log = data[LOG_KEY] || [];
  state.capturing = data[CAPTURING_KEY] !== false;
  state.captureAll = data[CAPTURE_ALL_KEY] === true;
  state.openCards = data[OPEN_CARDS_KEY] === true;
  if (data[FILTERS_KEY]) state.filters = { ...state.filters, ...data[FILTERS_KEY] };
  renderAll();
})();
