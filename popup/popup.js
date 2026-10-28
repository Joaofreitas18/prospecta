const STORE_KEY = "leads";
const STATE_KEY = "capturing";
const FILTER_KEY = "filters";
const LOG_KEY = "log";
const VERIFY_KEY = "verifying";
const AUTO_KEY = "autoComplete";

const TIPO_LABEL = {
  nenhum: "Sem site",
  rede_social: "Rede social",
  nao_verificado: "A verificar",
  proprio: "Site próprio",
};

const COLUMNS = [
  ["score", "Score"],
  ["nome", "Nome"],
  ["categoria", "Categoria"],
  ["telefone", "Telefone"],
  ["endereco", "Endereço"],
  ["nota", "Nota"],
  ["avaliacoes", "Avaliações"],
  ["tipo_site", "Tipo de site"],
  ["verificado", "Verificado"],
  ["site", "Site"],
  ["horario", "Horário"],
  ["lat", "Latitude"],
  ["lng", "Longitude"],
  ["busca", "Busca"],
  ["link_maps", "Link Maps"],
  ["capturado_em", "Capturado em"],
];

const $ = (id) => document.getElementById(id);
const state = {
  leads: {},
  log: [],
  capturing: true,
  verifying: false,
  autoVerify: false,
  filters: { type: "nosite", minReviews: 0, minScore: 0 },
  lastLogT: 0,
  openId: null,
};

$("version").textContent = "v" + chrome.runtime.getManifest().version;

// ---- filtros e csv ----

function applyFilters(list, f) {
  return list
    .filter((l) => {
      if (f.type === "nosite" && !["nenhum", "rede_social"].includes(l.tipo_site)) return false;
      if (f.type === "nenhum" && l.tipo_site !== "nenhum") return false;
      if ((l.avaliacoes || 0) < f.minReviews) return false;
      if ((l.score || 0) < f.minScore) return false;
      return true;
    })
    .sort((a, b) => b.score - a.score);
}

// ; + BOM senão o excel pt-br abre tudo numa coluna
function toCSV(rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    if (typeof v === "boolean") return v ? "sim" : "não";
    let s = typeof v === "number" ? String(v).replace(".", ",") : String(v);
    if (/^[=+\-@\t\r]/.test(s) && typeof v !== "number") s = "'" + s; // formula injection no excel
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = COLUMNS.map(([, label]) => label).join(";");
  const body = rows.map((r) => COLUMNS.map(([k]) => esc(r[k])).join(";"));
  return "﻿" + [header, ...body].join("\r\n");
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
const fmtNota = (n) => (n ? `${String(n).replace(".", ",")}★` : null);

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}min` : `${Math.round(m / 60)}h`;
}

function findLead(id, nome) {
  return state.leads[id] || Object.values(state.leads).find((l) => l.nome === nome);
}

function buildRow(lead, { metaParts = [], right }) {
  const btn = el("button", "row");
  btn.type = "button";
  btn.title = "Ver detalhes";
  btn.addEventListener("click", () => openSheet(lead.id));
  btn.append(el("span", "name", lead.nome));
  const meta = el("span", "meta");
  metaParts.filter(Boolean).forEach((p) => meta.append(typeof p === "string" ? el("span", "", p) : p));
  btn.append(meta);
  const side = el("span", "side");
  right.forEach((r) => side.append(r));
  side.append(el("span", `tag tag--${lead.tipo_site}`, TIPO_LABEL[lead.tipo_site] || lead.tipo_site));
  btn.append(side);
  return btn;
}

// ---- render ----

function renderSummary() {
  const all = Object.values(state.leads);
  const c = { nenhum: 0, rede_social: 0, nao_verificado: 0, proprio: 0 };
  all.forEach((l) => (c[l.tipo_site] = (c[l.tipo_site] || 0) + 1));
  const total = all.length;

  $("s-total").textContent = total;
  $("s-none").textContent = c.nenhum;
  $("s-social").textContent = c.rede_social;
  $("s-unknown").textContent = c.nao_verificado;
  $("s-site").textContent = c.proprio;
  [c.nenhum, c.rede_social, c.nao_verificado, c.proprio].forEach((n, i) => {
    $("bar").children[i].style.width = total ? `${(n / total) * 100}%` : "0";
  });

  $("auto").checked = state.autoVerify;
  const vb = $("verify");
  vb.textContent = state.verifying ? "Parar" : "Capturar tudo";
  vb.className = `btn btn--sm ${state.verifying ? "btn--stop" : "btn--primary"}`;
  vb.title = "Rola a lista até o fim e captura todos os lotes";

  const st = $("toggle");
  st.className = `status ${!state.capturing ? "paused" : state.verifying ? "verifying" : ""}`;
  $("toggle-label").textContent = !state.capturing ? "Pausado" : state.verifying ? "Capturando tudo" : "Capturando";
  st.title = state.capturing ? "Pausar captura" : "Retomar captura";
}

function renderFeed() {
  const feed = $("feed");
  feed.innerHTML = "";
  const newest = state.log[0]?.t || 0;
  state.log.slice(0, 50).forEach((e) => {
    const lead = findLead(e.id, e.nome) || { ...e, id: e.id };
    const view = { ...lead, tipo_site: e.tipo_site, score: e.score };
    const row = buildRow(view, {
      metaParts: [
        el("span", `score ${scoreClass(e.score)}`, e.score),
        e.acao === "verificado" ? "✓ verificado" : "capturado",
        e.categoria,
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
      metaParts: [fmtNota(l.nota), l.avaliacoes ? `${l.avaliacoes} aval.` : null, l.categoria],
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
  $("hint").innerHTML = "";
  if (all.length) {
    $("hint").append(el("b", "", n), " de ", el("b", "", all.length), " leads entram no CSV com esses filtros.");
  } else {
    $("hint").textContent = "Nenhum lead capturado ainda.";
  }
  $("export").disabled = n === 0;
  $("clear").disabled = all.length === 0;
}

// ---- ficha ----

function mapsLinks(l) {
  const hasCoords = l.lat != null && l.lng != null;
  const q = hasCoords ? `${l.lat},${l.lng}` : `${l.nome} ${l.endereco || ""}`;
  return {
    embed: `https://maps.google.com/maps?q=${encodeURIComponent(q)}&z=16&output=embed`,
    route: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}`,
    hasQuery: hasCoords || !!l.endereco,
  };
}

function infoRow(label, value, { href, copy, empty = "não informado" } = {}) {
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
    const b = el("button", "copy", "copiar");
    b.type = "button";
    b.addEventListener("click", async () => {
      await navigator.clipboard.writeText(copy);
      b.textContent = "copiado";
      b.classList.add("done");
      setTimeout(() => {
        b.textContent = "copiar";
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
  const mapKey = links.embed;
  if (mapKey !== lastMapKey) {
    map.innerHTML = "";
    if (links.hasQuery) {
      const f = document.createElement("iframe");
      f.src = links.embed;
      f.loading = "lazy";
      f.referrerPolicy = "no-referrer-when-downgrade";
      f.title = `Mapa de ${l.nome}`;
      map.append(f);
    } else {
      map.append(el("div", "nomap", "Localização ainda não capturada"));
    }
    lastMapKey = mapKey;
  }

  $("d-name").textContent = l.nome;
  $("d-sub").textContent = [l.categoria, fmtNota(l.nota), l.avaliacoes ? `${l.avaliacoes} avaliações` : null].filter(Boolean).join(" · ");
  $("d-score").textContent = l.score;
  $("d-score").className = `score ${scoreClass(l.score)}`;
  const tag = $("d-tag");
  tag.className = `tag tag--${l.tipo_site}`;
  tag.textContent = TIPO_LABEL[l.tipo_site] || l.tipo_site;

  const info = $("d-info");
  info.innerHTML = "";
  const phoneDigits = (l.telefone || "").replace(/\D/g, "");
  info.append(
    infoRow("Endereço", l.endereco, { copy: l.endereco }),
    infoRow("Telefone", l.telefone, { href: phoneDigits ? `tel:${phoneDigits}` : null, copy: l.telefone }),
    infoRow("Site", l.site ? l.site.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") : null, {
      href: l.site || null,
      empty: l.verificado ? "não tem site" : "ainda não verificado",
    }),
    infoRow("Horário", l.horario),
    infoRow("Busca", l.busca),
    infoRow("Capturado", l.capturado_em ? new Date(l.capturado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : null)
  );

  $("d-open").href = l.link_maps;
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

// ---- eventos ----

document.querySelectorAll(".tabs button").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((t) => t.setAttribute("aria-selected", t === tab));
    document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
  })
);

function saveFilters() {
  chrome.storage.local.set({ [FILTER_KEY]: state.filters });
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

$("auto").addEventListener("change", (e) => chrome.storage.local.set({ [AUTO_KEY]: e.target.checked }));
$("verify").addEventListener("click", () => chrome.storage.local.set({ [VERIFY_KEY]: !state.verifying }));
$("toggle").addEventListener("click", () => chrome.storage.local.set({ [STATE_KEY]: !state.capturing }));

$("export").addEventListener("click", () => {
  const rows = applyFilters(Object.values(state.leads), state.filters);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
  download(toCSV(rows), `prospecta-leads-${stamp}.csv`);
});

$("clear").addEventListener("click", () => {
  const n = Object.keys(state.leads).length;
  if (confirm(`Apagar os ${n} leads capturados e o log? Isso não pode ser desfeito.`)) {
    closeSheet();
    chrome.storage.local.set({ [STORE_KEY]: {}, [LOG_KEY]: [], clearedAt: Date.now() });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STORE_KEY]) state.leads = changes[STORE_KEY].newValue || {};
  if (changes[LOG_KEY]) state.log = changes[LOG_KEY].newValue || [];
  if (changes[STATE_KEY]) state.capturing = changes[STATE_KEY].newValue !== false;
  if (changes[VERIFY_KEY]) state.verifying = changes[VERIFY_KEY].newValue === true;
  if (changes[AUTO_KEY]) state.autoVerify = changes[AUTO_KEY].newValue === true;
  renderAll();
});

setInterval(renderFeed, 5000);

(async function init() {
  const data = await chrome.storage.local.get([STORE_KEY, STATE_KEY, FILTER_KEY, LOG_KEY, VERIFY_KEY, AUTO_KEY]);
  state.leads = data[STORE_KEY] || {};
  state.log = data[LOG_KEY] || [];
  state.capturing = data[STATE_KEY] !== false;
  state.verifying = data[VERIFY_KEY] === true;
  state.autoVerify = data[AUTO_KEY] === true;
  if (data[FILTER_KEY]) state.filters = { ...state.filters, ...data[FILTER_KEY] };
  renderAll();
})();
