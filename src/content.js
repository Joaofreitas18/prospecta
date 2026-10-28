(() => {
  const { parseCard, parseDetail, scoreLead, VERSION } = window.ProspectaParser;
  const STORE_KEY = "leads";
  const STATE_KEY = "capturing";
  const VERIFY_KEY = "verifying";
  const AUTO_KEY = "autoVerify";
  const LOG_KEY = "log";
  const LOG_MAX = 80;
  const CARD_SELECTOR = 'a[href*="/maps/place/"]';
  const IDLE_MS = 2500;

  let leads = {};
  let log = [];
  let capturing = true;
  let autoVerify = true;
  let fullRun = false; // botão "verificar tudo": também rola a lista
  let running = false;
  let dead = false;
  let lastInput = 0;
  let pending = new Set();
  let flushTimer = null;
  let hud = null;

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
    running = false;
    if (hud) {
      hud.className = "prsp-hud--dead";
      hud.innerHTML = "<strong>Prospecta foi atualizada</strong><span>aperte F5 nesta página</span>";
    }
  }

  const save = (obj) => {
    if (!alive()) return die();
    chrome.storage.local.set(obj).catch(die);
  };

  async function load() {
    const data = await chrome.storage.local.get([STORE_KEY, STATE_KEY, LOG_KEY, AUTO_KEY]);
    leads = data[STORE_KEY] || {};
    log = data[LOG_KEY] || [];
    capturing = data[STATE_KEY] !== false;
    autoVerify = data[AUTO_KEY] !== false;
    await chrome.storage.local.set({ [VERIFY_KEY]: false });
    renderHud();
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => save({ [STORE_KEY]: leads, [LOG_KEY]: log }), 300);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || dead) return;
    if (changes[STORE_KEY]) leads = changes[STORE_KEY].newValue || {};
    if (changes[LOG_KEY]) log = changes[LOG_KEY].newValue || [];
    if (changes[STATE_KEY]) capturing = changes[STATE_KEY].newValue !== false;
    if (changes[AUTO_KEY]) autoVerify = changes[AUTO_KEY].newValue !== false;
    if (changes[VERIFY_KEY]) {
      fullRun = changes[VERIFY_KEY].newValue === true;
      if (fullRun) kick();
    }
    renderHud();
    kick();
  });

  // só eventos reais do usuário; os cliques da própria extensão não contam
  ["wheel", "mousedown", "keydown", "touchstart"].forEach((type) =>
    window.addEventListener(
      type,
      (e) => {
        if (e.isTrusted && !e.target.closest?.("#prsp-hud")) lastInput = Date.now();
      },
      { capture: true, passive: true }
    )
  );

  function pushLog(acao, lead) {
    log.unshift({ t: Date.now(), acao, id: lead.id, nome: lead.nome, tipo_site: lead.tipo_site, score: lead.score, categoria: lead.categoria });
    if (log.length > LOG_MAX) log.length = LOG_MAX;
  }

  const BADGES = {
    nenhum: ["SEM SITE", "prsp-badge--none"],
    rede_social: ["SÓ REDE SOCIAL", "prsp-badge--social"],
    nao_verificado: ["VERIFICANDO…", "prsp-badge--unknown"],
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
    el.textContent = lead.verificado ? `${label} · ${lead.score}` : label;
  }

  const cardFor = (id) => [...document.querySelectorAll(CARD_SELECTOR)].find((a) => a.href.includes(id));

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
      kick();
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

  // ---- detalhe ----

  function applyDetail(d) {
    const lead = leads[d.id];
    if (!lead || lead.nome !== d.nome) return false;
    const fresh = !lead.verificado;
    if (!fresh && lead.site === d.site && (lead.telefone || !d.telefone)) return true;

    Object.assign(lead, {
      site: d.site,
      tipo_site: d.tipo_site,
      telefone: d.telefone || lead.telefone,
      endereco: d.endereco || lead.endereco,
      horario: d.horario || lead.horario,
      lat: d.lat ?? lead.lat,
      lng: d.lng ?? lead.lng,
      verificado: true,
    });
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
    detailTimer = setTimeout(() => {
      if (!capturing || dead || running) return;
      const d = parseDetail();
      if (d) applyDetail(d);
    }, 700);
  }

  // ---- verificação ----

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (min, max) => min + Math.random() * (max - min);
  const userBusy = () => Date.now() - lastInput < IDLE_MS;

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
      const id = parseCard(a)?.id;
      const lead = id && leads[id];
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

  let kickTimer = null;
  function kick() {
    clearTimeout(kickTimer);
    kickTimer = setTimeout(() => {
      if (!running && capturing && !dead && (autoVerify || fullRun)) loop();
    }, 400);
  }

  async function loop() {
    running = true;
    renderHud();
    while (!dead && capturing && (autoVerify || fullRun)) {
      // usuário rolando ou clicando: espera ele parar
      if (userBusy() && !fullRun) {
        renderHud("esperando você parar de rolar");
        await sleep(600);
        continue;
      }
      let a = nextUnverified();
      if (!a) {
        if (!fullRun || !(await loadMore())) break;
        a = nextUnverified();
        if (!a) break;
      }
      const lead = leads[parseCard(a).id];
      renderHud(`verificando ${lead.nome}`);
      if (fullRun) a.scrollIntoView({ block: "center" });
      a.click();
      const d = await waitDetailFor(lead);
      if (d) applyDetail(d);
      else {
        lead.tentativas = (lead.tentativas || 0) + 1;
        scheduleFlush();
      }
      await sleep(jitter(1000, 1800));
    }
    running = false;
    if (fullRun) {
      fullRun = false;
      save({ [VERIFY_KEY]: false });
    }
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
    if (detail) checkDetail();
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

  function renderHud(activity) {
    if (!document.body || dead) return;
    if (!hud) {
      hud = document.createElement("div");
      hud.id = "prsp-hud";
      hud.addEventListener("click", (e) => {
        const act = e.target.closest("[data-act]")?.dataset.act;
        if (!act) return;
        if (!alive()) return die();
        if (act === "pause") save({ [STATE_KEY]: !capturing });
        if (act === "all") save({ [VERIFY_KEY]: !fullRun });
      });
      document.body.appendChild(hud);
    }
    const c = counts();
    hud.className = !capturing ? "prsp-hud--paused" : running ? "prsp-hud--verify" : "";
    const status = !capturing ? "Pausado" : running ? "Verificando" : "Capturando";
    const sub = !capturing ? "" : activity || (running ? "" : c.pendentes ? "para de rolar que eu verifico" : "tudo verificado");
    hud.innerHTML = `
      <span class="prsp-hud__brand">Prospecta <em>v${VERSION}</em></span>
      <span class="prsp-hud__status"><i></i>${status}<small></small></span>
      <span class="prsp-hud__num"><b>${c.total}</b> leads</span>
      <span class="prsp-hud__num prsp-hud__none"><b>${c.semSite}</b> sem site</span>
      <span class="prsp-hud__num prsp-hud__social"><b>${c.social}</b> rede social</span>
      <span class="prsp-hud__num prsp-hud__pending"><b>${c.pendentes}</b> a verificar</span>
      <button data-act="all" type="button">${fullRun ? "Parar" : "Verificar tudo"}</button>
      <button data-act="pause" type="button">${capturing ? "Pausar" : "Retomar"}</button>
    `;
    // texto via textContent porque pode ter nome vindo do maps
    const small = hud.querySelector("small");
    small.textContent = sub;
    small.hidden = !sub;
  }

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
    kick();
  });
})();
