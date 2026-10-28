(() => {
  const { parseCard, parseDetail, parseSearchBody, scoreLead, VERSION } = window.ProspectaParser;
  const LEADS_KEY = "leads";
  const CAPTURING_KEY = "capturing";
  const CAPTURE_ALL_KEY = "verifying";
  const OPEN_CARDS_KEY = "autoComplete"; // click fallback, off by default
  const LOCK_KEY = "verifyLock";
  const CLEARED_KEY = "clearedAt";
  const LOG_KEY = "log";
  const LOG_MAX = 80;
  const CARD_SELECTOR = 'a[href*="/maps/place/"]';
  const IDLE_MS = 2000;
  const LOCK_TTL = 6000;
  const MAX_ATTEMPTS = 2;
  const TAB = Math.random().toString(36).slice(2);

  let leads = {};
  let log = [];
  let capturing = true;
  let openCards = false;
  let captureAll = false; // "capture all" button: also scrolls the list
  let running = false;
  let dead = false;
  let lastInput = 0;
  let clearedAt = 0;
  let pending = new Set();
  let flushTimer = null;
  let hud = null;

  const debug = (...a) => console.debug("[Prospecta]", ...a);
  const t = (key, ...args) =>
    (chrome.i18n?.getMessage(key) || key).replace(/\{(\d)\}/g, (_, i) => args[i] ?? "");

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
      hud.innerHTML = "<strong></strong><span></span>";
      // static text, but the extension context is gone so getMessage may fail
      hud.querySelector("strong").textContent = "Prospecta";
      hud.querySelector("span").textContent = "F5";
    }
  }

  const save = (obj) => {
    if (!alive()) return die();
    return chrome.storage.local.set(obj).catch(die);
  };

  // ---- data shared between tabs ----
  // every tab keeps its own copy; on save they are merged lead by lead, newest wins

  function mergeLeads(a = {}, b = {}) {
    const out = { ...a };
    for (const [id, lb] of Object.entries(b)) {
      if ((lb.updatedAt || 0) < clearedAt) continue;
      const la = out[id];
      if (!la || (lb.updatedAt || 0) > (la.updatedAt || 0)) out[id] = lb;
    }
    for (const id of Object.keys(out)) if ((out[id].updatedAt || 0) < clearedAt) delete out[id];
    return out;
  }

  function mergeLog(a = [], b = []) {
    const seen = new Set();
    return [...a, ...b]
      .filter((e) => e.t >= clearedAt)
      .sort((x, y) => y.t - x.t)
      .filter((e) => {
        const k = `${e.t}|${e.id}|${e.action}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, LOG_MAX);
  }

  function touch(lead) {
    lead.updatedAt = Date.now();
    return lead;
  }

  async function flush() {
    if (!alive()) return die();
    try {
      const cur = await chrome.storage.local.get([LEADS_KEY, LOG_KEY]);
      leads = mergeLeads(cur[LEADS_KEY], leads);
      log = mergeLog(cur[LOG_KEY], log);
      await save({ [LEADS_KEY]: leads, [LOG_KEY]: log });
    } catch {
      die();
    }
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 300);
  }

  async function load() {
    const data = await chrome.storage.local.get([LEADS_KEY, CAPTURING_KEY, LOG_KEY, OPEN_CARDS_KEY, CLEARED_KEY, CAPTURE_ALL_KEY]);
    clearedAt = data[CLEARED_KEY] || 0;
    // merge, a batch may have arrived while loading
    leads = mergeLeads(data[LEADS_KEY], leads);
    log = mergeLog(data[LOG_KEY], log);
    capturing = data[CAPTURING_KEY] !== false;
    openCards = data[OPEN_CARDS_KEY] === true;
    captureAll = data[CAPTURE_ALL_KEY] === true;
    renderHud();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || dead) return;
    if (changes[CLEARED_KEY]) {
      clearedAt = changes[CLEARED_KEY].newValue || 0;
      leads = {};
      log = [];
    }
    if (changes[LEADS_KEY]) leads = mergeLeads(leads, changes[LEADS_KEY].newValue);
    if (changes[LOG_KEY]) log = mergeLog(log, changes[LOG_KEY].newValue);
    if (changes[CAPTURING_KEY]) {
      capturing = changes[CAPTURING_KEY].newValue !== false;
      if (capturing) [...pausedBatches].forEach((u) => (pausedBatches.delete(u), readBatch(u)));
    }
    if (changes[OPEN_CARDS_KEY]) openCards = changes[OPEN_CARDS_KEY].newValue === true;
    if (changes[CAPTURE_ALL_KEY]) captureAll = changes[CAPTURE_ALL_KEY].newValue === true;
    renderHud();
    kick();
  });

  // ---- lock: only one tab opens cards at a time ----

  async function holdLock() {
    const cur = (await chrome.storage.local.get(LOCK_KEY))[LOCK_KEY];
    const free = !cur || cur.owner === TAB || Date.now() - cur.ts > LOCK_TTL;
    if (!free) return false;
    await save({ [LOCK_KEY]: { owner: TAB, ts: Date.now() } });
    return true;
  }

  function releaseLock() {
    chrome.storage.local
      .get(LOCK_KEY)
      .then((d) => {
        if (d[LOCK_KEY]?.owner === TAB) chrome.storage.local.remove(LOCK_KEY);
      })
      .catch(() => {});
  }
  window.addEventListener("pagehide", releaseLock);

  // only real user input counts; the extension's own clicks don't
  ["wheel", "mousedown", "keydown", "touchstart"].forEach((type) =>
    window.addEventListener(
      type,
      (e) => {
        if (e.isTrusted && !e.target.closest?.("#prsp-hud")) lastInput = Date.now();
      },
      { capture: true, passive: true }
    )
  );

  function pushLog(action, lead) {
    log.unshift({ t: Date.now(), action, id: lead.id, name: lead.name, siteType: lead.siteType, score: lead.score, category: lead.category });
    if (log.length > LOG_MAX) log.length = LOG_MAX;
  }

  const BADGES = {
    none: ["badgeNone", "prsp-badge--none"],
    social: ["badgeSocial", "prsp-badge--social"],
    unverified: ["badgeUnverified", "prsp-badge--unknown"],
    own: ["badgeOwn", "prsp-badge--site"],
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
    let [key, cls] = BADGES[lead.siteType] || BADGES.unverified;
    if (!lead.verified && (lead.attempts || 0) >= MAX_ATTEMPTS) key = "badgeFailed";
    el.className = `prsp-badge ${cls}`;
    el.textContent = lead.verified ? `${t(key)} · ${lead.score}` : t(key);
  }

  const idOf = (a) => parseCard(a)?.id;
  const cardFor = (id) => [...document.querySelectorAll(CARD_SELECTOR)].find((a) => a.href.includes(id));

  // ---- result list ----

  function processAnchor(anchor) {
    if (!capturing || dead) return;
    const lead = parseCard(anchor);
    if (!lead) return;
    const existing = leads[lead.id];
    if (!existing) {
      leads[lead.id] = touch(lead);
      pushLog("new", lead);
      scheduleFlush();
      renderHud();
      kick();
      setTimeout(kick, 8500); // the click fallback only applies after 8s
    } else if (existing.source === "batch" && !existing.mapsUrl?.includes("/place/")) {
      // the batch arrived before the card; swap the short link for the card's one
      existing.mapsUrl = lead.mapsUrl;
      touch(existing);
      scheduleFlush();
    } else if (!existing.verified && ((!existing.rating && lead.rating) || (!existing.category && lead.category))) {
      leads[lead.id] = touch({ ...existing, ...lead, capturedAt: existing.capturedAt });
      scheduleFlush();
    }
    markCard(anchor, leads[lead.id]);
  }

  function scan() {
    document.querySelectorAll(CARD_SELECTOR).forEach((a) => pending.add(a));
    drain();
  }

  // cards are inserted empty and Maps fills them in afterwards
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

  // ---- batches (no clicking) ----

  const seenBatches = new Set();
  const pausedBatches = new Set();
  const normUrl = (u) => {
    try {
      return new URL(u, location.href).href;
    } catch {
      return u;
    }
  };

  function ingestBatch(places) {
    if (!capturing || dead || !places.length) return;
    let added = 0;
    for (const p of places) {
      const ex = leads[p.id];
      if (ex?.verified && ex.source === "detail") continue; // the detail pane has more data
      const merged = {
        ...ex,
        ...p,
        query: ex?.query || p.query,
        capturedAt: ex?.capturedAt || p.capturedAt,
        mapsUrl: ex?.mapsUrl?.includes("/place/") ? ex.mapsUrl : p.mapsUrl,
        hours: ex?.hours || "",
        attempts: 0,
      };
      leads[p.id] = touch(merged);
      if (!ex?.verified) {
        pushLog("verified", merged);
        added++;
      }
      const a = cardFor(p.id);
      if (a) markCard(a, merged);
    }
    if (added) debug(`batch: ${places.length} places, ${added} new`);
    scheduleFlush();
    renderHud();
  }

  // every batch is a /search?tbm=map request; as soon as it finishes,
  // read the same response again and classify all 20 at once
  async function readBatch(url) {
    const key = normUrl(url);
    if (seenBatches.has(key) || dead) return;
    if (!capturing) return pausedBatches.add(url); // read when resumed
    seenBatches.add(key);
    try {
      const res = await fetch(url, { credentials: "include", cache: "force-cache" });
      ingestBatch(parseSearchBody(await res.text()));
    } catch (err) {
      debug("could not read batch", String(err));
    }
  }

  // our own re-reads show up here too; seenBatches keeps them from being read twice
  const isMapsBatch = (e) => e.name.includes("tbm=map");

  function watchBatches() {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (isMapsBatch(e)) readBatch(e.name);
      }).observe({ type: "resource", buffered: true });
    } catch {
      // no PerformanceObserver: poll instead
      setInterval(() => performance.getEntriesByType("resource").forEach((e) => isMapsBatch(e) && readBatch(e.name)), 1500);
    }
  }

  // ---- detail pane ----

  function applyDetail(d) {
    // match by id; if Maps changed the id format, fall back to the name
    const lead = leads[d.id] || Object.values(leads).find((l) => l.name === d.name && !l.verified);
    if (!lead) return false;
    if (lead.verified && lead.site === d.site && (lead.phone || !d.phone)) return true;

    Object.assign(lead, {
      site: d.site,
      siteType: d.siteType,
      phone: d.phone || lead.phone,
      address: d.address || lead.address,
      hours: d.hours || lead.hours,
      lat: d.lat ?? lead.lat,
      lng: d.lng ?? lead.lng,
      verified: true,
      source: "detail",
    });
    lead.score = scoreLead({ siteType: lead.siteType, reviews: lead.reviews, rating: lead.rating, phone: lead.phone });
    touch(lead);
    pushLog("verified", lead);
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

  // ---- capture all / click fallback ----

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (min, max) => min + Math.random() * (max - min);
  const userBusy = () => Date.now() - lastInput < IDLE_MS;

  async function waitDetailFor(id, name, timeout = 6000) {
    const start = Date.now();
    let seen = null;
    let reclicked = false;
    while (Date.now() - start < timeout) {
      await sleep(150);
      // Maps sometimes redraws the list and the click gets lost
      if (!reclicked && Date.now() - start > 2000) {
        reclicked = true;
        cardFor(id)?.click();
      }
      const d = parseDetail();
      if (!d) continue;
      seen = d;
      if (d.id === id || d.name === name) {
        await sleep(300); // the website sometimes renders after the address
        return parseDetail() || d;
      }
    }
    debug("detail did not open", { expected: name, id, pane: seen?.name, paneId: seen?.id });
    return null;
  }

  function nextUnverified() {
    return [...document.querySelectorAll(CARD_SELECTOR)].find((a) => {
      const lead = leads[idOf(a)];
      const age = Date.now() - (Date.parse(lead?.capturedAt) || 0);
      return lead && !lead.verified && (lead.attempts || 0) < MAX_ATTEMPTS && age > 8000;
    });
  }

  const END_OF_LIST_RE = /chegou ao final da lista|reached the end of the list/i;
  // Google cuts the list short when it thinks usage looks automated
  const limitedView = () =>
    /visualiza[çc][ãa]o limitada|limited view of google maps/i.test(document.querySelector('[role="feed"]')?.innerText || "");

  async function loadMore() {
    const feed = document.querySelector('[role="feed"]');
    if (!feed || END_OF_LIST_RE.test(feed.innerText)) return false;
    const before = document.querySelectorAll(CARD_SELECTOR).length;
    // Maps only asks for the next batch when it sees the scroll reach the bottom;
    // scrolling to the same spot again doesn't count, so every so often nudge up and back
    for (let i = 0; i < 38; i++) {
      if (i % 6 === 5) {
        feed.scrollTop = Math.max(0, feed.scrollHeight - feed.clientHeight - 600);
        await sleep(150);
      }
      feed.scrollTop = feed.scrollHeight;
      await sleep(400);
      scan();
      if (document.querySelectorAll(CARD_SELECTOR).length > before) return true;
      if (END_OF_LIST_RE.test(feed.innerText) || limitedView()) return false;
    }
    return false;
  }

  let kickTimer = null;
  function kick() {
    clearTimeout(kickTimer);
    kickTimer = setTimeout(() => {
      if (!running && capturing && !dead && (openCards || captureAll) && document.visibilityState === "visible") loop();
    }, 300);
  }
  document.addEventListener("visibilitychange", kick);

  async function loop() {
    running = true;
    renderHud();
    while (!dead && capturing && (openCards || captureAll)) {
      if (document.visibilityState !== "visible") break;
      if (!captureAll && !(openCards && nextUnverified())) break;
      if (!(await holdLock())) {
        renderHud(t("hudOtherTab"));
        await sleep(2000);
        continue;
      }
      if (userBusy() && !captureAll) {
        renderHud(t("hudWaitScroll"));
        await sleep(400);
        continue;
      }
      const a = openCards ? nextUnverified() : null;
      if (!a) {
        if (captureAll) renderHud(t("hudScrolling"));
        if (captureAll && limitedView()) {
          renderHud(t("hudLimited"));
          await sleep(4000);
          break;
        }
        if (!captureAll || !(await loadMore())) {
          // some card may not have reached the 8s mark yet; wait a bit before giving up
          if (openCards && Object.values(leads).some((l) => !l.verified && (l.attempts || 0) < MAX_ATTEMPTS)) {
            await sleep(1500);
            if (nextUnverified()) continue;
          }
          break;
        }
        await sleep(jitter(1000, 2000)); // human-ish pace so Google doesn't limit the list
        continue;
      }
      const id = idOf(a);
      const name = leads[id].name;
      renderHud(t("hudChecking", name));
      if (captureAll) a.scrollIntoView({ block: "center" });
      a.click();
      const d = await waitDetailFor(id, name);
      if (!(d && applyDetail(d))) {
        // always go through the id, the old reference may have been replaced by a merge
        if (leads[id]) {
          leads[id].attempts = (leads[id].attempts || 0) + 1;
          touch(leads[id]);
          markCard(a, leads[id]);
        }
        scheduleFlush();
      }
      await sleep(jitter(500, 1000));
    }
    running = false;
    releaseLock();
    if (captureAll && !dead && !nextUnverified()) {
      captureAll = false;
      save({ [CAPTURE_ALL_KEY]: false });
    }
    renderHud();
  }

  // ---- DOM observer ----

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

  // ---- on-page HUD ----

  function counts() {
    const all = Object.values(leads);
    return {
      total: all.length,
      none: all.filter((l) => l.siteType === "none").length,
      social: all.filter((l) => l.siteType === "social").length,
      pending: all.filter((l) => !l.verified && (l.attempts || 0) < MAX_ATTEMPTS).length,
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
        if (act === "pause") save({ [CAPTURING_KEY]: !capturing });
        if (act === "all") save({ [CAPTURE_ALL_KEY]: !captureAll });
      });
      document.body.appendChild(hud);
    }
    const c = counts();
    hud.className = !capturing ? "prsp-hud--paused" : running ? "prsp-hud--verify" : "";
    const status = !capturing ? t("statusPaused") : running ? t(captureAll ? "statusCapturingAll" : "statusVerifying") : t("statusCapturing");
    const sub = !capturing ? "" : lastActivity || t(c.pending ? "hudHintPending" : "hudHintIdle");
    hud.innerHTML = `
      <span class="prsp-hud__brand">Prospecta <em>v${VERSION}</em></span>
      <span class="prsp-hud__status"><i></i><span data-k="status"></span><small></small></span>
      <span class="prsp-hud__num"><b>${c.total}</b> <span data-k="leads"></span></span>
      <span class="prsp-hud__num prsp-hud__none"><b>${c.none}</b> <span data-k="none"></span></span>
      <span class="prsp-hud__num prsp-hud__social"><b>${c.social}</b> <span data-k="social"></span></span>
      <span class="prsp-hud__num prsp-hud__pending"><b>${c.pending}</b> <span data-k="pending"></span></span>
      <button data-act="all" type="button"></button>
      <button data-act="pause" type="button"></button>
    `;
    // text goes in through textContent, place names come from Maps
    const set = (sel, text) => (hud.querySelector(sel).textContent = text);
    set('[data-k="status"]', status);
    set('[data-k="leads"]', t("hudLeads"));
    set('[data-k="none"]', t("hudNone"));
    set('[data-k="social"]', t("hudSocial"));
    set('[data-k="pending"]', t("hudPending"));
    set('[data-act="all"]', t(captureAll ? "actionStop" : "actionCaptureAll"));
    set('[data-act="pause"]', t(capturing ? "actionPause" : "actionResume"));
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
    watchBatches();
    scan();
    checkDetail();
    kick();
  });
})();
