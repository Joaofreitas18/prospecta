const STORE_KEY = "leads";
const STATE_KEY = "capturing";
const FILTER_KEY = "filters";
const LOG_KEY = "log";
const VERIFY_KEY = "verifying";

const TIPO_LABEL = {
  nenhum: "Sem site",
  rede_social: "Rede social",
  nao_verificado: "Não verificado",
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
  filters: { type: "nosite", minReviews: 0, minScore: 0 },
  lastLogT: 0,
};

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
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // formula injection no excel
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

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function scoreClass(s) {
  return s >= 70 ? "hi" : s >= 40 ? "mid" : "lo";
}

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}min`;
  return `${Math.round(m / 60)}h`;
}

function buildRow({ nome, categoria, tipo_site, score, extra }) {
  const li = el("li", "row");
  li.append(el("div", "name", nome));
  const meta = el("div", "meta");
  if (extra) meta.append(el("span", "", extra));
  if (categoria) meta.append(el("span", "", categoria));
  li.append(meta);
  const side = el("div", "side");
  side.append(el("span", `score ${scoreClass(score)}`, score));
  side.append(el("span", `tag tag--${tipo_site}`, TIPO_LABEL[tipo_site] || tipo_site));
  li.append(side);
  return li;
}

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

  const segs = $("bar").children;
  [c.nenhum, c.rede_social, c.nao_verificado, c.proprio].forEach((n, i) => {
    segs[i].style.width = total ? `${(n / total) * 100}%` : "0";
  });

  const pend = all.filter((l) => !l.verificado).length;
  $("s-pending").textContent = pend;
  const vb = $("verify");
  vb.textContent = state.verifying ? "Parar" : "Verificar sites";
  vb.className = `btn btn--sm ${state.verifying ? "btn--stop" : "btn--primary"}`;
  vb.disabled = !state.verifying && pend === 0;

  const btn = $("toggle");
  btn.classList.toggle("paused", !state.capturing);
  $("toggle-label").textContent = !state.capturing ? "Pausado" : state.verifying ? "Verificando" : "Capturando";
  btn.title = state.capturing ? "Pausar captura" : "Retomar captura";
}

function renderFeed() {
  const feed = $("feed");
  feed.innerHTML = "";
  const newest = state.log[0]?.t || 0;
  state.log.slice(0, 40).forEach((e) => {
    const row = buildRow({ ...e, extra: e.acao === "verificado" ? "✓ verificado" : null });
    const side = row.querySelector(".side");
    side.prepend(el("span", "time", ago(e.t)));
    side.querySelector(".score").remove();
    row.querySelector(".meta").prepend(el("span", `score ${scoreClass(e.score)}`, e.score));
    if (e.t > state.lastLogT && state.lastLogT) row.classList.add("fresh");
    feed.append(row);
  });
  state.lastLogT = newest;
  $("feed-empty").hidden = state.log.length > 0;

  const recent = state.log.filter((e) => Date.now() - e.t < 60000).length;
  $("c-live").textContent = recent ? `+${recent}` : "";
}

function renderBest() {
  const list = applyFilters(Object.values(state.leads), state.filters).slice(0, 25);
  const rank = $("rank");
  rank.innerHTML = "";
  list.forEach((l, i) => {
    const row = buildRow({
      ...l,
      extra: [l.nota ? `${String(l.nota).replace(".", ",")}★` : null, l.avaliacoes ? `${l.avaliacoes} aval.` : null]
        .filter(Boolean)
        .join(" · "),
    });
    row.prepend(el("span", "pos", String(i + 1).padStart(2, "0")));
    const a = el("a");
    a.href = l.link_maps;
    a.target = "_blank";
    a.rel = "noopener";
    a.append(row);
    const li = el("li");
    li.append(a);
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
  $("hint").innerHTML = all.length
    ? `<b>${n}</b> de <b>${all.length}</b> leads entram no CSV com esses filtros.`
    : "Nenhum lead capturado ainda.";
  $("export").disabled = n === 0;
  $("clear").disabled = all.length === 0;
}

function renderAll() {
  renderSummary();
  renderFeed();
  renderBest();
  renderExport();
}

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
    chrome.storage.local.set({ [STORE_KEY]: {}, [LOG_KEY]: [] });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STORE_KEY]) state.leads = changes[STORE_KEY].newValue || {};
  if (changes[LOG_KEY]) state.log = changes[LOG_KEY].newValue || [];
  if (changes[STATE_KEY]) state.capturing = changes[STATE_KEY].newValue !== false;
  if (changes[VERIFY_KEY]) state.verifying = changes[VERIFY_KEY].newValue === true;
  if (changes[STORE_KEY] || changes[LOG_KEY] || changes[STATE_KEY] || changes[VERIFY_KEY]) renderAll();
});

setInterval(renderFeed, 5000);

(async function init() {
  const data = await chrome.storage.local.get([STORE_KEY, STATE_KEY, FILTER_KEY, LOG_KEY, VERIFY_KEY]);
  state.verifying = data[VERIFY_KEY] === true;
  state.leads = data[STORE_KEY] || {};
  state.log = data[LOG_KEY] || [];
  state.capturing = data[STATE_KEY] !== false;
  if (data[FILTER_KEY]) state.filters = { ...state.filters, ...data[FILTER_KEY] };
  renderAll();
})();
