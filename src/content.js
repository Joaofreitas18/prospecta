(() => {
  const { parseCard } = window.ProspectaParser;
  const STORE_KEY = "leads";
  const STATE_KEY = "capturing";
  const LOG_KEY = "log";
  const LOG_MAX = 60;
  const CARD_SELECTOR = 'a[href*="/maps/place/"]';

  let leads = {};
  let log = [];
  let capturing = true;
  let pending = new Set();
  let flushTimer = null;
  let hud = null;

  async function load() {
    const data = await chrome.storage.local.get([STORE_KEY, STATE_KEY, LOG_KEY]);
    leads = data[STORE_KEY] || {};
    log = data[LOG_KEY] || [];
    capturing = data[STATE_KEY] !== false;
    renderHud();
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      chrome.storage.local.set({ [STORE_KEY]: leads, [LOG_KEY]: log });
    }, 400);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORE_KEY]) leads = changes[STORE_KEY].newValue || {};
    if (changes[LOG_KEY]) log = changes[LOG_KEY].newValue || [];
    if (changes[STATE_KEY]) capturing = changes[STATE_KEY].newValue !== false;
    renderHud();
  });

  function badgeFor(lead) {
    if (lead.tipo_site === "nenhum") return ["SEM SITE", "prsp-badge--none"];
    if (lead.tipo_site === "rede_social") return ["SÓ REDE SOCIAL", "prsp-badge--social"];
    if (lead.tipo_site === "nao_verificado") return ["NÃO VERIFICADO", "prsp-badge--unknown"];
    return ["TEM SITE", "prsp-badge--site"];
  }

  function markCard(anchor, lead) {
    const card = anchor.closest('[role="article"]') || anchor.parentElement;
    if (!card || card.querySelector(".prsp-badge")) return;
    const [label, cls] = badgeFor(lead);
    const el = document.createElement("span");
    el.className = `prsp-badge ${cls}`;
    el.textContent = `${label} · ${lead.score}`;
    el.title = "Prospecta - score de prioridade (0-100)";
    card.style.position = card.style.position || "relative";
    card.appendChild(el);
  }

  function processAnchor(anchor) {
    if (!capturing) return;
    const lead = parseCard(anchor);
    if (!lead) return;

    const existing = leads[lead.id];
    // atualiza se veio telefone/site que antes nao tinha
    if (!existing || (!existing.telefone && lead.telefone) || (!existing.site && lead.site)) {
      leads[lead.id] = { ...existing, ...lead, capturado_em: existing?.capturado_em || lead.capturado_em };
      log.unshift({
        t: Date.now(),
        acao: existing ? "atualizado" : "novo",
        nome: lead.nome,
        tipo_site: lead.tipo_site,
        score: lead.score,
        categoria: lead.categoria,
      });
      if (log.length > LOG_MAX) log.length = LOG_MAX;
      scheduleFlush();
      renderHud();
    }
    markCard(anchor, leads[lead.id]);
  }

  function scan(root = document) {
    root.querySelectorAll(CARD_SELECTOR).forEach((a) => pending.add(a));
    drain();
  }

  // o card entra vazio e o maps preenche depois
  let draining = false;
  function drain() {
    if (draining) return;
    draining = true;
    const run = () => {
      pending.forEach((a) => {
        if (a.isConnected) processAnchor(a);
      });
      pending.clear();
      draining = false;
    };
    (window.requestIdleCallback || setTimeout)(run, { timeout: 500 });
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        if (node.matches?.(CARD_SELECTOR)) pending.add(node);
        node.querySelectorAll?.(CARD_SELECTOR).forEach((a) => pending.add(a));
      });
      if (m.type === "characterData" || m.type === "attributes") {
        const a = m.target.parentElement?.closest?.('[role="article"]')?.querySelector(CARD_SELECTOR);
        if (a) pending.add(a);
      }
    }
    if (pending.size) drain();
  });

  function counts() {
    const all = Object.values(leads);
    return {
      total: all.length,
      semSite: all.filter((l) => l.tipo_site === "nenhum").length,
      social: all.filter((l) => l.tipo_site === "rede_social").length,
    };
  }

  function renderHud() {
    if (!document.body) return;
    if (!hud) {
      hud = document.createElement("div");
      hud.id = "prsp-hud";
      hud.addEventListener("click", () => {
        chrome.storage.local.set({ [STATE_KEY]: !capturing });
      });
      document.body.appendChild(hud);
    }
    const c = counts();
    hud.classList.toggle("prsp-hud--paused", !capturing);
    hud.innerHTML = `
      <strong>${capturing ? "● Capturando" : "❚❚ Pausado"}</strong>
      <span>${c.total} leads</span>
      <span class="prsp-hud__none">${c.semSite} sem site</span>
      <span class="prsp-hud__social">${c.social} só rede social</span>
    `;
    hud.title = capturing ? "Clique para pausar a captura" : "Clique para retomar a captura";
  }

  load().then(() => {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "href"],
    });
    scan();
  });
})();
