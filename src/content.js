(() => {
  const { parseCard, parseDetail, scoreLead, VERSION } = window.ProspectaParser;
  const STORE_KEY = "leads";
  const STATE_KEY = "capturing";
  const VERIFY_KEY = "verifying";
  const AUTO_KEY = "autoVerify";
  const LOCK_KEY = "verifyLock";
  const CLEAR_KEY = "clearedAt";
  const LOG_KEY = "log";
  const LOG_MAX = 80;
  const CARD_SELECTOR = 'a[href*="/maps/place/"]';
  const IDLE_MS = 2000;
  const LOCK_TTL = 6000;
  const MAX_TRIES = 2;
  const TAB = Math.random().toString(36).slice(2);

  let leads = {};
  let log = [];
  let capturing = true;
  let autoVerify = true;
  let fullRun = false; // botão "verificar tudo": também rola a lista
  let running = false;
  let dead = false;
  let lastInput = 0;
  let clearedAt = 0;
  let pending = new Set();
  let flushTimer = null;
  let hud = null;
  let lockOwner = null;
  const stats = { ok: 0, falhas: 0 };

  const debug = (...a) => console.debug("[Prospecta]", ...a);

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
    return chrome.storage.local.set(obj).catch(die);
  };

  // ---- dados compartilhados entre abas ----
  // cada aba tem sua cópia; na hora de salvar mescla lead a lead pelo mais recente

  function mergeLeads(a = {}, b = {}) {
    const out = { ...a };
    for (const [id, lb] of Object.entries(b)) {
      if ((lb.atualizado_em || 0) < clearedAt) continue;
      const la = out[id];
      if (!la || (lb.atualizado_em || 0) > (la.atualizado_em || 0)) out[id] = lb;
    }
    for (const id of Object.keys(out)) if ((out[id].atualizado_em || 0) < clearedAt) delete out[id];
    return out;
  }

  function mergeLog(a = [], b = []) {
    const seen = new Set();
    return [...a, ...b]
      .filter((e) => e.t >= clearedAt)
      .sort((x, y) => y.t - x.t)
      .filter((e) => {
        const k = `${e.t}|${e.id}|${e.acao}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, LOG_MAX);
  }

  function touch(lead) {
    lead.atualizado_em = Date.now();
    return lead;
  }

  async function flush() {
    if (!alive()) return die();
    try {
      const cur = await chrome.storage.local.get([STORE_KEY, LOG_KEY]);
      leads = mergeLeads(cur[STORE_KEY], leads);
      log = mergeLog(cur[LOG_KEY], log);
      await save({ [STORE_KEY]: leads, [LOG_KEY]: log });
    } catch {
      die();
    }
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 300);
  }

  async function load() {
    const data = await chrome.storage.local.get([STORE_KEY, STATE_KEY, LOG_KEY, AUTO_KEY, CLEAR_KEY, VERIFY_KEY]);
    clearedAt = data[CLEAR_KEY] || 0;
    leads = data[STORE_KEY] || {};
    log = data[LOG_KEY] || [];
    capturing = data[STATE_KEY] !== false;
    autoVerify = data[AUTO_KEY] !== false;
    fullRun = data[VERIFY_KEY] === true;
    renderHud();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || dead) return;
    if (changes[CLEAR_KEY]) {
      clearedAt = changes[CLEAR_KEY].newValue || 0;
      leads = {};
      log = [];
    }
    if (changes[STORE_KEY]) leads = mergeLeads(leads, changes[STORE_KEY].newValue);
    if (changes[LOG_KEY]) log = mergeLog(log, changes[LOG_KEY].newValue);
    if (changes[STATE_KEY]) capturing = changes[STATE_KEY].newValue !== false;
    if (changes[AUTO_KEY]) autoVerify = changes[AUTO_KEY].newValue !== false;
    if (changes[VERIFY_KEY]) fullRun = changes[VERIFY_KEY].newValue === true;
    if (changes[LOCK_KEY]) lockOwner = changes[LOCK_KEY].newValue?.owner || null;
    renderHud();
    kick();
  });

  // ---- trava: só uma aba verifica por vez ----

  async function holdLock() {
    const cur = (await chrome.storage.local.get(LOCK_KEY))[LOCK_KEY];
    const free = !cur || cur.owner === TAB || Date.now() - cur.ts > LOCK_TTL;
    if (!free) return false;
    await save({ [LOCK_KEY]: { owner: TAB, ts: Date.now() } });
    return true;
  }

  function releaseLock() {
    chrome.storage.local.get(LOCK_KEY).then((d) => {
      if (d[LOCK_KEY]?.owner === TAB) chrome.storage.local.remove(LOCK_KEY);
    }).catch(() => {});
  }
  window.addEventListener("pagehide", releaseLock);

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
    let [label, cls] = BADGES[lead.tipo_site] || BADGES.nao_verificado;
    if (!lead.verificado && (lead.tentativas || 0) >= MAX_TRIES) label = "NÃO ABRIU";
    el.className = `prsp-badge ${cls}`;
    el.textContent = lead.verificado ? `${label} · ${lead.score}` : label;
  }

  const idOf = (a) => parseCard(a)?.id;
  const cardFor = (id) => [...document.querySelectorAll(CARD_SELECTOR)].find((a) => a.href.includes(id));

  // ---- lista ----

  function processAnchor(anchor) {
    if (!capturing || dead) return;
    const lead = parseCard(anchor);
    if (!lead) return;
    const existing = leads[lead.id];
    if (!existing) {
      leads[lead.id] = touch(lead);
      pushLog("novo", lead);
      scheduleFlush();
      renderHud();
      kick();
    } else if (!existing.verificado && ((!existing.nota && lead.nota) || (!existing.categoria && lead.categoria))) {
      leads[lead.id] = touch({ ...existing, ...lead, capturado_em: existing.capturado_em });
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
    // aceita pelo id; se o maps mudou o formato do id, cai pro nome
    const lead = leads[d.id] || Object.values(leads).find((l) => l.nome === d.nome && !l.verificado);
    if (!lead) return false;
    if (lead.verificado && lead.site === d.site && (lead.telefone || !d.telefone)) return true;

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
    touch(lead);
    pushLog("verificado", lead);
    scheduleFlush();
    renderHud();
    const a = cardFor(lead.id);
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
    }, 500);
  }

  // ---- verificação ----

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (min, max) => min + Math.random() * (max - min);
  const userBusy = () => Date.now() - lastInput < IDLE_MS;

  async function waitDetailFor(id, nome, timeout = 6000) {
    const start = Date.now();
    let seen = null;
    let reclicked = false;
    while (Date.now() - start < timeout) {
      await sleep(150);
      // o maps às vezes redesenha a lista e o clique se perde
      if (!reclicked && Date.now() - start > 2000) {
        reclicked = true;
        cardFor(id)?.click();
      }
      const d = parseDetail();
      if (!d) continue;
      seen = d;
      if (d.id === id || d.nome === nome) {
        await sleep(300); // site às vezes chega depois do endereço
        return parseDetail() || d;
      }
    }
    debug("detalhe não abriu", { esperado: nome, id, painel: seen?.nome, idPainel: seen?.id, url: location.href.slice(0, 120) });
    return null;
  }

  function nextUnverified() {
    return [...document.querySelectorAll(CARD_SELECTOR)].find((a) => {
      const lead = leads[idOf(a)];
      return lead && !lead.verificado && (lead.tentativas || 0) < MAX_TRIES;
    });
  }

  async function loadMore() {
    const feed = document.querySelector('[role="feed"]');
    if (!feed) return false;
    const before = document.querySelectorAll(CARD_SELECTOR).length;
    for (let i = 0; i < 4; i++) {
      feed.scrollTop = feed.scrollHeight;
      await sleep(1200);
      scan();
      if (document.querySelectorAll(CARD_SELECTOR).length > before) return true;
    }
    return false;
  }

  let kickTimer = null;
  function kick() {
    clearTimeout(kickTimer);
    kickTimer = setTimeout(() => {
      if (!running && capturing && !dead && (autoVerify || fullRun) && document.visibilityState === "visible") loop();
    }, 300);
  }
  document.addEventListener("visibilitychange", kick);

  async function loop() {
    running = true;
    renderHud();
    while (!dead && capturing && (autoVerify || fullRun)) {
      if (document.visibilityState !== "visible") break;
      if (!fullRun && !nextUnverified()) break;
      if (!(await holdLock())) {
        renderHud("outra aba do Maps está verificando");
        await sleep(2000);
        continue;
      }
      if (userBusy() && !fullRun) {
        renderHud("esperando você parar de rolar");
        await sleep(400);
        continue;
      }
      let a = nextUnverified();
      if (!a) {
        if (!fullRun || !(await loadMore())) break;
        a = nextUnverified();
        if (!a) break;
      }
      const id = idOf(a);
      const nome = leads[id].nome;
      renderHud(`verificando ${nome}`);
      if (fullRun) a.scrollIntoView({ block: "center" });
      a.click();
      const d = await waitDetailFor(id, nome);
      if (d && applyDetail(d)) {
        stats.ok++;
      } else {
        stats.falhas++;
        // sempre pelo id, a referência antiga pode ter sido trocada pela mescla
        if (leads[id]) {
          leads[id].tentativas = (leads[id].tentativas || 0) + 1;
          touch(leads[id]);
          markCard(a, leads[id]);
        }
        scheduleFlush();
      }
      await sleep(jitter(500, 1000));
    }
    running = false;
    releaseLock();
    if (fullRun && !dead && !nextUnverified()) {
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
      pendentes: all.filter((l) => !l.verificado && (l.tentativas || 0) < MAX_TRIES).length,
    };
  }

  let lastActivity = "";
  function renderHud(activity) {
    if (!document.body || dead) return;
    if (activity !== undefined) lastActivity = activity;
    if (!running) lastActivity = "";
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
    const sub = !capturing ? "" : lastActivity || (c.pendentes ? "para de rolar que eu verifico" : "tudo verificado");
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
