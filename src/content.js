(() => {
  const { parseCard, parseDetail, scoreLead } = window.ProspectaParser;
  const STORE_KEY = "leads";
  const STATE_KEY = "capturing";
  const VERIFY_KEY = "verifying";
  const LOG_KEY = "log";
  const LOG_MAX = 80;
  const CARD_SELECTOR = 'a[href*="/maps/place/"]';

  let leads = {};
  let log = [];
  let capturing = true;
  let verifying = false;
  let dead = false;
  let pending = new Set();
  let flushTimer = null;
  let hud = null;

  // se a extensão foi recarregada, essa instância fica órfã
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  function die() {
    if (dead) return;
    dead = true;
    observer.disconnect();
    verifying = false;
    if (hud) {
      hud.className = "prsp-hud--dead";
      hud.innerHTML = "<strong>Prospecta foi atualizada</strong><span>aperte F5 nesta página</span>";
    }
  }

  async function load() {
    const data = await chrome.storage.local.get([STORE_KEY, STATE_KEY, LOG_KEY]);
    leads = data[STORE_KEY] || {};
    log = data[LOG_KEY] || [];
    capturing = data[STATE_KEY] !== false;
    // nunca começa verificando sozinho depois de um F5
    await chrome.storage.local.set({ [VERIFY_KEY]: false });
    renderHud();
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      if (!alive()) return die();
      chrome.storage.local.set({ [STORE_KEY]: leads, [LOG_KEY]: log }).catch(die);
    }, 300);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || dead) return;
    if (changes[STORE_KEY]) leads = changes[STORE_KEY].newValue || {};
    if (changes[LOG_KEY]) log = changes[LOG_KEY].newValue || [];
    if (changes[STATE_KEY]) capturing = changes[STATE_KEY].newValue !== false;
    if (changes[VERIFY_KEY]) {
      const v = changes[VERIFY_KEY].newValue === true;
      if (v && !verifying) runVerify();
      verifying = v;
    }
    renderHud();
  });

  function pushLog(acao, lead) {
    log.unshift({
      t: Date.now(),
      acao,
      nome: lead.nome,
      tipo_site: lead.tipo_site,
      score: lead.score,
      categoria: lead.categoria,
    });
    if (log.length > LOG_MAX) log.length = LOG_MAX;
  }

  const BADGES = {
    nenhum: ["SEM SITE", "prsp-badge--none"],
    rede_social: ["SÓ REDE SOCIAL", "prsp-badge--social"],
    nao_verificado: ["NÃO VERIFICADO", "prsp-badge--unknown"],
    proprio: ["TEM SITE", "prsp-badge--site"],
  };

  function markCard(anchor, lead) {
    const card = anchor.closest('[role="article"]') || anchor.parentElement;
    if (!card) return;
    let el = card.querySelector(".prsp-badge");
    if (!el) {
      el = document.createElement("span");
      card.style.position = card.style.position || "relative";
      card.appendChild(el);
    }
    const [label, cls] = BADGES[lead.tipo_site] || BADGES.nao_verificado;
    el.className = `prsp-badge ${cls}`;
    el.textContent = `${label} · ${lead.score}`;
  }

  function cardFor(id) {
    return [...document.querySelectorAll(CARD_SELECTOR)].find((a) => a.href.includes(id));
  }

  // ---- lista ----

  function processAnchor(anchor) {
    if (!capturing || dead) return;
    const lead = parseCard(anchor);
    if (!lead) return;

    const existing = leads[lead.id];
    if (!existing) {
      leads[lead.id] = lead;
      pushLog("novo", lead);
      scheduleFlush();
      renderHud();
    } else if (!existing.verificado && ((!existing.nota && lead.nota) || (!existing.categoria && lead.categoria))) {
      leads[lead.id] = { ...existing, ...lead, capturado_em: existing.capturado_em };
      scheduleFlush();
    }
    markCard(anchor, leads[lead.id]);
  }

  function scan() {
    document.querySelectorAll(CARD_SELECTOR).forEach((a) => pending.add(a));
    drain();
  }

  // o card entra vazio e o maps preenche depois
  let draining = false;
  function drain() {
    if (draining) return;
    draining = true;
    (window.requestIdleCallback || setTimeout)(
      () => {
        pending.forEach((a) => a.isConnected && processAnchor(a));
        pending.clear();
        draining = false;
      },
      { timeout: 500 }
    );
  }

  // ---- painel de detalhes ----

  function applyDetail(d) {
    const lead = leads[d.id];
    if (!lead || lead.nome !== d.nome) return false;
    const changed = !lead.verificado || lead.site !== d.site || (!lead.telefone && d.telefone);
    if (!changed) return true;

    lead.site = d.site;
    lead.tipo_site = d.tipo_site;
    if (d.telefone) lead.telefone = d.telefone;
    lead.verificado = true;
    lead.score = scoreLead({ siteType: lead.tipo_site, reviews: lead.avaliacoes, rating: lead.nota, phone: lead.telefone });
    pushLog("verificado", lead);
    scheduleFlush();
    renderHud();
    const a = cardFor(d.id);
    if (a) markCard(a, lead);
    return true;
  }

  let detailTimer = null;
  function checkDetail() {
    clearTimeout(detailTimer);
    // espera o painel terminar de renderizar o bloco de site/telefone
    detailTimer = setTimeout(() => {
      if (!capturing || dead) return;
      const d = parseDetail();
      if (d) applyDetail(d);
    }, 700);
  }

  // ---- verificação automática ----

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (min, max) => min + Math.random() * (max - min);

  async function waitDetailFor(lead, timeout = 7000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await sleep(250);
      const d = parseDetail();
      if (d && d.id === lead.id && d.nome === lead.nome) {
        await sleep(500); // site às vezes chega depois do endereço
        return parseDetail() || d;
      }
    }
    return null;
  }

  function nextUnverified() {
    return [...document.querySelectorAll(CARD_SELECTOR)].find((a) => {
      const lead = leads[parseCard(a)?.id];
      return lead && !lead.verificado && (lead.tentativas || 0) < 2;
    });
  }

  async function loadMore() {
    const feed = document.querySelector('[role="feed"]');
    if (!feed) return false;
    const before = document.querySelectorAll(CARD_SELECTOR).length;
    for (let i = 0; i < 4; i++) {
      feed.scrollTop = feed.scrollHeight;
      await sleep(1500);
      scan();
      if (document.querySelectorAll(CARD_SELECTOR).length > before) return true;
    }
    return false;
  }

  async function runVerify() {
    verifying = true;
    renderHud();
    while (verifying && !dead) {
      let a = nextUnverified();
      if (!a) {
        if (!(await loadMore())) break;
        a = nextUnverified();
        if (!a) break;
      }
      const lead = leads[parseCard(a).id];
      a.scrollIntoView({ block: "center" });
      a.click();
      const d = await waitDetailFor(lead);
      if (d) {
        applyDetail(d);
      } else {
        lead.tentativas = (lead.tentativas || 0) + 1;
        scheduleFlush();
      }
      await sleep(jitter(1200, 2200));
    }
    verifying = false;
    if (alive()) chrome.storage.local.set({ [VERIFY_KEY]: false }).catch(die);
    renderHud();
  }

  // ---- observer ----

  const observer = new MutationObserver((mutations) => {
    if (!alive()) return die();
    let detail = false;
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        if (node.matches?.(CARD_SELECTOR)) pending.add(node);
        node.querySelectorAll?.(CARD_SELECTOR).forEach((a) => pending.add(a));
        if (node.matches?.("[data-item-id]") || node.querySelector?.("[data-item-id]")) detail = true;
      });
      if (m.type === "attributes") {
        const a = m.target.closest?.('[role="article"]')?.querySelector(CARD_SELECTOR);
        if (a) pending.add(a);
        if (m.target.matches?.("[data-item-id]")) detail = true;
      }
    }
    if (pending.size) drain();
    if (detail && !verifying) checkDetail();
  });

  // ---- HUD ----

  function counts() {
    const all = Object.values(leads);
    return {
      total: all.length,
      semSite: all.filter((l) => l.tipo_site === "nenhum").length,
      social: all.filter((l) => l.tipo_site === "rede_social").length,
      pendentes: all.filter((l) => !l.verificado).length,
    };
  }

  function renderHud() {
    if (!document.body || dead) return;
    if (!hud) {
      hud = document.createElement("div");
      hud.id = "prsp-hud";
      hud.addEventListener("click", () => {
        if (!alive()) return die();
        chrome.storage.local.set({ [STATE_KEY]: !capturing });
      });
      document.body.appendChild(hud);
    }
    const c = counts();
    hud.className = !capturing ? "prsp-hud--paused" : verifying ? "prsp-hud--verify" : "";
    const status = !capturing ? "❚❚ Pausado" : verifying ? "● Verificando sites" : "● Capturando";
    hud.innerHTML = `
      <strong>${status}</strong>
      <span>${c.total} leads</span>
      <span class="prsp-hud__none">${c.semSite} sem site</span>
      <span class="prsp-hud__social">${c.social} rede social</span>
      <span class="prsp-hud__pending">${c.pendentes} a verificar</span>
    `;
    hud.title = capturing ? "Clique para pausar" : "Clique para retomar";
  }

  // limpa o HUD de uma instância antiga, se a extensão foi recarregada
  document.getElementById("prsp-hud")?.remove();

  load().then(() => {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-label", "href", "data-item-id"],
    });
    scan();
    checkDetail();
  });
})();
