(() => {
  const SOCIAL_RE =
    /(instagram\.com|facebook\.com|fb\.com|fb\.me|linktr\.ee|wa\.me|whatsapp\.com|api\.whatsapp|tiktok\.com|bio\.link|beacons\.ai|linkbio|taplink)/i;
  const PHONE_RE = /(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}/;
  const STATUS_RE = /^(aberto|fechado|abre|fecha|open|closed|opens|closes|temporariamente|permanentemente)/i;

  function resolveHref(href) {
    try {
      const u = new URL(href);
      if (/google\./.test(u.hostname) && u.pathname === "/url") {
        return u.searchParams.get("q") || u.searchParams.get("url") || href;
      }
      return href;
    } catch {
      return href;
    }
  }

  function isGoogleInternal(href) {
    try {
      const host = new URL(href).hostname;
      return /(^|\.)google\.[a-z.]+$/i.test(host) || /(^|\.)gstatic\.com$/i.test(host);
    } catch {
      return true;
    }
  }

  function placeKey(href) {
    const id = href.match(/!1s([^!?]+)/);
    if (id) return decodeURIComponent(id[1]);
    const slug = href.match(/\/maps\/place\/([^/?]+)/);
    return slug ? decodeURIComponent(slug[1]) : href.split("?")[0];
  }

  function coords(href) {
    const m = href.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    return m ? { lat: parseFloat(m[1]), lng: parseFloat(m[2]) } : { lat: null, lng: null };
  }

  function parseNumber(str) {
    if (!str) return null;
    // "1.234" -> 1234, "4,6" -> 4.6
    const clean = str.replace(/\./g, "").replace(",", ".");
    const n = parseFloat(clean);
    return Number.isFinite(n) ? n : null;
  }

  function parseRating(card, text) {
    let rating = null;
    let reviews = null;

    const img = card.querySelector('[role="img"][aria-label]');
    if (img) {
      const label = img.getAttribute("aria-label");
      const r = label.match(/(\d[,.]\d)/);
      if (r) rating = parseNumber(r[1]);
      const rv = label.match(/(\d[\d.]*)\s*(avalia|coment|review)/i);
      if (rv) reviews = parseNumber(rv[1]);
    }

    // fallback: "4,6(1.234)"
    if (rating === null || reviews === null) {
      const m = text.match(/(\d[,.]\d)\s*\(([\d.]+)\)/);
      if (m) {
        if (rating === null) rating = parseNumber(m[1]);
        if (reviews === null) reviews = parseNumber(m[2]);
      }
    }
    return { rating, reviews: reviews ?? 0 };
  }

  const SITE_LABEL_RE = /^(web\s?site|site)$|visitar o site|acessar o site|website/i;

  function parseWebsite(card) {
    const links = [...card.querySelectorAll("a[href]")]
      .map((a) => resolveHref(a.href))
      .filter((h) => /^https?:/i.test(h) && !isGoogleInternal(h));

    const siteButton = [...card.querySelectorAll("a, button")].find((el) => {
      const label = `${el.getAttribute("data-value") || ""} ${el.getAttribute("aria-label") || ""}`.trim();
      return label && SITE_LABEL_RE.test(label);
    });

    if (links.length) {
      const site = links[0];
      return { site, siteType: SOCIAL_RE.test(site) ? "rede_social" : "proprio" };
    }
    if (siteButton) {
      const href = siteButton.href ? resolveHref(siteButton.href) : "";
      return { site: href, siteType: href && SOCIAL_RE.test(href) ? "rede_social" : "proprio" };
    }

    const hasActionButtons = card.querySelector(
      'a[data-value], button[data-value], [aria-label*="Rotas" i], [aria-label*="Directions" i], [aria-label*="Ligar" i]'
    );
    return { site: "", siteType: hasActionButtons ? "nenhum" : "nao_verificado" };
  }

  function parseCategoryAddress(lines, name) {
    for (const line of lines) {
      if (line === name || STATUS_RE.test(line) || /^\d[,.]\d/.test(line)) continue;
      if (!line.includes("·")) continue;
      const parts = line
        .split("·")
        .map((s) => s.trim())
        .filter((s) => s && !/^[\u2000-\u2BFF\uE000-\uF8FF]+$/.test(s)); // icones do maps
      if (parts.length === 0) continue;
      return { category: parts[0] || "", address: parts[1] || "" };
    }
    return { category: "", address: "" };
  }

  function scoreLead({ siteType, reviews, rating, phone }) {
    let score = 0;
    if (siteType === "nenhum") score += 40;
    else if (siteType === "rede_social") score += 35;
    else if (siteType === "nao_verificado") score += 15;

    score += Math.min(35, Math.log10((reviews || 0) + 1) * 14);

    if (rating >= 4.3) score += 15;
    else if (rating >= 4.0) score += 8;

    if (phone) score += 10;
    return Math.round(Math.min(100, score));
  }

  // com o detalhe aberto a url vira /maps/place/, então guarda a última busca
  let lastSearch = "";
  function searchTerm() {
    const m = location.pathname.match(/\/maps\/search\/([^/@]+)/);
    if (m) lastSearch = decodeURIComponent(m[1]).replace(/\+/g, " ");
    return lastSearch;
  }

  function parseCard(anchor) {
    const name = (anchor.getAttribute("aria-label") || "").trim();
    if (!name) return null;

    const card = anchor.closest('[role="article"]') || anchor.parentElement;
    if (!card) return null;

    const text = card.innerText || "";
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const { rating, reviews } = parseRating(card, text);
    const { site, siteType } = parseWebsite(card);
    const { category, address } = parseCategoryAddress(lines, name);
    const phoneMatch = text.match(PHONE_RE);
    const phone = phoneMatch ? phoneMatch[0].trim() : "";

    const lead = {
      id: placeKey(anchor.href),
      nome: name,
      categoria: category,
      endereco: address,
      telefone: phone,
      nota: rating,
      avaliacoes: reviews,
      site,
      tipo_site: siteType,
      busca: searchTerm(),
      link_maps: anchor.href.split("?")[0],
      ...coords(anchor.href),
      capturado_em: new Date().toISOString(),
    };
    lead.score = scoreLead({ siteType, reviews, rating, phone });
    return lead;
  }

  const DAYS = ["segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"];

  // a tabela de horário vem como "quinta-feira, 08:00 a 20:00, Copiar horário..."
  function parseHours(scope) {
    const byDay = {};
    scope.querySelectorAll("[aria-label]").forEach((el) => {
      const parts = el.getAttribute("aria-label").split(",").map((p) => p.trim());
      const day = DAYS.find((d) => parts[0].toLowerCase().startsWith(d));
      if (day && parts[1] && !byDay[day]) byDay[day] = parts[1];
    });
    return DAYS.filter((d) => byDay[d])
      .map((d) => `${d.slice(0, 3)} ${byDay[d]}`)
      .join(" · ");
  }

  // painel de detalhes que abre ao clicar no card; é o único lugar com o site
  function parseDetail() {
    const address = document.querySelector('[data-item-id="address"]');
    if (!address) return null;
    const pane = address.closest('[role="main"]');
    const nome = (pane?.getAttribute("aria-label") || "").trim();
    const idMatch = location.href.match(/!1s([^!?]+)/);
    if (!nome || !idMatch) return null;

    const scope = pane || document;
    const authority = scope.querySelector('a[data-item-id="authority"]');
    const site = authority ? resolveHref(authority.href) : "";
    const phoneEl = scope.querySelector('[data-item-id^="phone:tel:"]');
    let telefone = "";
    if (phoneEl) {
      const label = phoneEl.getAttribute("aria-label") || phoneEl.innerText || "";
      telefone = (label.match(PHONE_RE) || [""])[0].trim() || phoneEl.getAttribute("data-item-id").replace("phone:tel:", "");
    }

    const endereco = (address.getAttribute("aria-label") || "").replace(/^Endereço:\s*/i, "").trim();
    const horario = parseHours(scope);

    return {
      id: decodeURIComponent(idMatch[1]),
      nome,
      endereco,
      horario,
      ...coords(location.href),
      site,
      tipo_site: !site ? "nenhum" : SOCIAL_RE.test(site) ? "rede_social" : "proprio",
      telefone,
    };
  }

  window.ProspectaParser = { parseCard, parseDetail, scoreLead, placeKey, VERSION: "1.3.0" };
})();
