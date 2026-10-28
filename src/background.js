const LEADS_KEY = "leads";
const CAPTURING_KEY = "capturing";
const SCHEMA_KEY = "schema";
const SCHEMA = 2;
const MAPS_URLS = ["https://www.google.com/maps/*", "https://www.google.com.br/maps/*"];

const t = (key, ...args) => (chrome.i18n.getMessage(key) || key).replace(/\{(\d)\}/g, (_, i) => args[i] ?? "");

chrome.runtime.onInstalled.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  await migrate();
  updateBadge();
  reinject();
});
chrome.runtime.onStartup.addListener(async () => {
  await migrate();
  updateBadge();
});

// builds before 1.5 stored data with Portuguese field names
const LEGACY_FIELDS = {
  nome: "name",
  categoria: "category",
  endereco: "address",
  telefone: "phone",
  nota: "rating",
  avaliacoes: "reviews",
  tipo_site: "siteType",
  busca: "query",
  link_maps: "mapsUrl",
  capturado_em: "capturedAt",
  atualizado_em: "updatedAt",
  horario: "hours",
  verificado: "verified",
  fonte: "source",
  tentativas: "attempts",
  acao: "action",
};
const LEGACY_VALUES = {
  siteType: { nenhum: "none", rede_social: "social", proprio: "own", nao_verificado: "unverified" },
  source: { lote: "batch", detalhe: "detail" },
  action: { novo: "new", verificado: "verified" },
};

function renameFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = LEGACY_FIELDS[k] || k;
    out[key] = LEGACY_VALUES[key]?.[v] ?? v;
  }
  return out;
}

async function migrate() {
  const data = await chrome.storage.local.get([SCHEMA_KEY, LEADS_KEY, "log", "filters"]);
  if (data[SCHEMA_KEY] >= SCHEMA) return;
  const leads = Object.fromEntries(Object.entries(data[LEADS_KEY] || {}).map(([id, l]) => [id, renameFields(l)]));
  const log = (data.log || []).map(renameFields);
  const filters = data.filters ? { ...data.filters, type: data.filters.type === "nenhum" ? "none" : data.filters.type } : undefined;
  await chrome.storage.local.set({ [LEADS_KEY]: leads, log, ...(filters && { filters }), [SCHEMA_KEY]: SCHEMA });
}

// Maps tabs that were open before install/update don't have the content script
async function reinject() {
  const tabs = await chrome.tabs.query({ url: MAPS_URLS });
  for (const tab of tabs) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["src/content.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/parser.js", "src/content.js"] });
    } catch {}
  }
}

function compact(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(".0", "") + "k";
  return Math.round(n / 1000) + "k";
}

async function updateBadge() {
  const data = await chrome.storage.local.get([LEADS_KEY, CAPTURING_KEY]);
  const leads = Object.values(data[LEADS_KEY] || {});
  const capturing = data[CAPTURING_KEY] !== false;
  const noSite = leads.filter((l) => l.siteType === "none" || l.siteType === "social").length;

  await chrome.action.setBadgeText({ text: leads.length ? compact(noSite) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: capturing ? "#1e8e3e" : "#5f6368" });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  await chrome.action.setTitle({ title: t(capturing ? "badgeTitle" : "badgeTitlePaused", leads.length, noSite) });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[LEADS_KEY] || changes[CAPTURING_KEY])) updateBadge();
});
