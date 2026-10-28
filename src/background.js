const STORE_KEY = "leads";
const STATE_KEY = "capturing";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  updateBadge();
  reinject();
});

// abas do maps abertas antes da instalação/atualização ficam sem o script
async function reinject() {
  const tabs = await chrome.tabs.query({ url: ["https://www.google.com/maps/*", "https://www.google.com.br/maps/*"] });
  for (const tab of tabs) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["src/content.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/parser.js", "src/content.js"] });
    } catch {}
  }
}
chrome.runtime.onStartup.addListener(updateBadge);

function compact(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(".0", "") + "k";
  return Math.round(n / 1000) + "k";
}

async function updateBadge() {
  const data = await chrome.storage.local.get([STORE_KEY, STATE_KEY]);
  const leads = Object.values(data[STORE_KEY] || {});
  const capturing = data[STATE_KEY] !== false;
  const semSite = leads.filter((l) => l.tipo_site === "nenhum" || l.tipo_site === "rede_social").length;

  await chrome.action.setBadgeText({ text: leads.length ? compact(semSite) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: capturing ? "#1e8e3e" : "#5f6368" });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  await chrome.action.setTitle({
    title: `Prospecta - ${leads.length} leads, ${semSite} sem site próprio${capturing ? "" : " (pausado)"}`,
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[STORE_KEY] || changes[STATE_KEY])) updateBadge();
});
