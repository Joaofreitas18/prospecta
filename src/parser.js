(() => {
  const SOCIAL_RE =
    /(instagram\.com|facebook\.com|fb\.com|fb\.me|linktr\.ee|wa\.me|whatsapp\.com|api\.whatsapp|tiktok\.com|bio\.link|beacons\.ai|linkbio|taplink|contate\.me|lnk\.bio|linkr\.bio|msha\.ke|youtube\.com|twitter\.com|x\.com\/|kwai)/i;
  const PHONE_RE = /(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}/;
  // Maps UI text comes in the user's language, so these match Portuguese and English
  const STATUS_RE = /^(aberto|fechado|abre|fecha|open|closed|opens|closes|temporariamente|permanentemente|temporarily|permanently)/i;
  const SITE_LABEL_RE = /^(web\s?site|site)$|visitar o site|acessar o site|website/i;

  const siteTypeOf = (url) => (!url ? "none" : SOCIAL_RE.test(url) ? "social" : "own");

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
    const n = parseFloat(str.replace(/\./g, "").replace(",", "."));
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
      const rv = label.match(/(\d[\d.,]*)\s*(avalia|coment|review)/i);
      if (rv) reviews = parseNumber(rv[1]);
    }

    // fallback: "4,6(1.234)"
    if (rating === null || reviews === null) {
      const m = text.match(/(\d[,.]\d)\s*\(([\d.,]+)\)/);
      if (m) {
        if (rating === null) rating = parseNumber(m[1]);
        if (reviews === null) reviews = parseNumber(m[2]);
      }
    }
    return { rating, reviews: reviews ?? 0 };
  }

  function parseWebsite(card) {
    const links = [...card.querySelectorAll("a[href]")]
      .map((a) => resolveHref(a.href))
      .filter((h) => /^https?:/i.test(h) && !isGoogleInternal(h));
    if (links.length) return { site: links[0], siteType: siteTypeOf(links[0]) };

    const siteButton = [...card.querySelectorAll("a, button")].find((el) => {
      const label = `${el.getAttribute("data-value") || ""} ${el.getAttribute("aria-label") || ""}`.trim();
      return label && SITE_LABEL_RE.test(label);
    });
    if (siteButton) {
      const href = siteButton.href ? resolveHref(siteButton.href) : "";
      return { site: href, siteType: href ? siteTypeOf(href) : "own" };
    }

    // only call it "none" when the card shows its action buttons and none is a website
    const hasActionButtons = card.querySelector(
      'a[data-value], button[data-value], [aria-label*="Rotas" i], [aria-label*="Directions" i], [aria-label*="Ligar" i], [aria-label*="Call" i]'
    );
    return { site: "", siteType: hasActionButtons ? "none" : "unverified" };
  }

  function parseCategoryAddress(lines, name) {
    for (const line of lines) {
      if (line === name || STATUS_RE.test(line) || /^\d[,.]\d/.test(line)) continue;
      if (!line.includes("·")) continue;
      const parts = line
        .split("·")
        .map((s) => s.trim())
        .filter((s) => s && !/^[ -⯿-]+$/.test(s)); // Maps icon glyphs
      if (parts.length) return { category: parts[0] || "", address: parts[1] || "" };
    }
    return { category: "", address: "" };
  }

  // a good lead has no website of its own but already has traction
  function scoreLead({ siteType, reviews, rating, phone }) {
    let score = 0;
    if (siteType === "none") score += 40;
    else if (siteType === "social") score += 35;
    else if (siteType === "unverified") score += 15;

    score += Math.min(35, Math.log10((reviews || 0) + 1) * 14);

    if (rating >= 4.3) score += 15;
    else if (rating >= 4.0) score += 8;

    if (phone) score += 10;
    return Math.round(Math.min(100, score));
  }

  // once a place is open the URL becomes /maps/place/, so remember the last search
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
    const phone = (text.match(PHONE_RE) || [""])[0].trim();

    const lead = {
      id: placeKey(anchor.href),
      name,
      category,
      address,
      phone,
      rating,
      reviews,
      site,
      siteType,
      query: searchTerm(),
      mapsUrl: anchor.href.split("?")[0],
      ...coords(anchor.href),
      capturedAt: new Date().toISOString(),
    };
    lead.score = scoreLead({ siteType, reviews, rating, phone });
    return lead;
  }

  const DAYS = [
    ["mon", "segunda", "monday"],
    ["tue", "terça", "tuesday"],
    ["wed", "quarta", "wednesday"],
    ["thu", "quinta", "thursday"],
    ["fri", "sexta", "friday"],
    ["sat", "sábado", "saturday"],
    ["sun", "domingo", "sunday"],
  ];

  // the hours table comes as "quinta-feira, 08:00 a 20:00, Copiar horário..."
  function parseHours(scope) {
    const byDay = {};
    scope.querySelectorAll("[aria-label]").forEach((el) => {
      const parts = el.getAttribute("aria-label").split(",").map((p) => p.trim());
      const first = parts[0].toLowerCase();
      const day = DAYS.find(([, pt, en]) => first.startsWith(pt) || first.startsWith(en));
      if (day && parts[1] && !byDay[day[0]]) byDay[day[0]] = parts[1];
    });
    return DAYS.filter(([key]) => byDay[key])
      .map(([key, pt]) => `${pt.slice(0, 3)} ${byDay[key]}`)
      .join(" · ");
  }

  // the detail pane that opens when a card is clicked
  function parseDetail() {
    // places without an address (delivery, home service) have no "address" item
    const address = document.querySelector('[data-item-id="address"]');
    const pane =
      address?.closest('[role="main"]') ||
      [...document.querySelectorAll('[role="main"][aria-label]')].find(
        (m) => !m.querySelector('[role="feed"]') && m.querySelector("[data-item-id]")
      );
    if (!pane) return null;
    const name = (pane.getAttribute("aria-label") || "").trim();
    const idMatch = location.href.match(/!1s([^!?]+)/);
    if (!name || !idMatch) return null;

    const authority = pane.querySelector('a[data-item-id="authority"]');
    const site = authority ? resolveHref(authority.href) : "";
    const phoneEl = pane.querySelector('[data-item-id^="phone:tel:"]');
    let phone = "";
    if (phoneEl) {
      const label = phoneEl.getAttribute("aria-label") || phoneEl.innerText || "";
      phone = (label.match(PHONE_RE) || [""])[0].trim() || phoneEl.getAttribute("data-item-id").replace("phone:tel:", "");
    }

    return {
      id: decodeURIComponent(idMatch[1]),
      name,
      address: (address?.getAttribute("aria-label") || "").replace(/^(Endereço|Address):\s*/i, "").trim(),
      hours: parseHours(pane),
      ...coords(location.href),
      site,
      siteType: siteTypeOf(site),
      phone,
    };
  }

  // ---- search batches ----
  // Maps loads results 20 at a time through /search?tbm=map, and every batch already
  // carries website, phone and address, so places can be classified without a click

  const at = (o, ...keys) => {
    try {
      return keys.reduce((a, k) => (a == null ? undefined : a[k]), o);
    } catch {
      return undefined;
    }
  };
  const stripXssi = (t) => t.replace(/^\)\]\}'\n?/, "").replace(/\/\*""\*\/\s*$/, "");
  const isPlaceId = (v) => typeof v === "string" && /^0x[0-9a-f]+:0x[0-9a-f]+$/i.test(v);

  function findResultList(root) {
    let found = null;
    const walk = (v, depth) => {
      if (found || depth > 5 || !Array.isArray(v)) return;
      if (v.length && v.some((r) => isPlaceId(at(r, 1, 10)))) {
        found = v;
        return;
      }
      v.forEach((x) => walk(x, depth + 1));
    };
    walk(root, 0);
    return found || [];
  }

  function cidLink(id) {
    try {
      return `https://www.google.com/maps?cid=${BigInt(id.split(":")[1]).toString()}`;
    } catch {
      return "";
    }
  }

  function parseSearchBody(text) {
    let data;
    try {
      data = JSON.parse(stripXssi(text));
      // the first batch is wrapped in {c, d}, the following ones are not
      if (data && !Array.isArray(data) && typeof data.d === "string") data = JSON.parse(stripXssi(data.d));
    } catch {
      return [];
    }
    const query = searchTerm();
    return findResultList(data)
      .map((r) => r?.[1])
      .filter((p) => isPlaceId(at(p, 10)) && at(p, 11))
      .map((p) => {
        const id = p[10];
        const rawSite = at(p, 7, 0);
        let site = "";
        if (typeof rawSite === "string") {
          try {
            site = resolveHref(new URL(rawSite, "https://www.google.com").href);
          } catch {
            site = rawSite;
          }
        }
        const phone = at(p, 178, 0, 0) || "";
        const rating = typeof at(p, 4, 7) === "number" ? at(p, 4, 7) : null;
        const reviews = typeof at(p, 4, 8) === "number" ? at(p, 4, 8) : 0;
        const siteType = siteTypeOf(site);
        const lead = {
          id,
          name: p[11],
          category: at(p, 13, 0) || "",
          address: at(p, 39) || "",
          phone,
          rating,
          reviews,
          site,
          siteType,
          query,
          mapsUrl: cidLink(id),
          lat: at(p, 9, 2) ?? null,
          lng: at(p, 9, 3) ?? null,
          verified: true,
          source: "batch",
          capturedAt: new Date().toISOString(),
        };
        lead.score = scoreLead({ siteType, reviews, rating, phone });
        return lead;
      });
  }

  window.ProspectaParser = { parseCard, parseDetail, parseSearchBody, scoreLead, placeKey, VERSION: "1.5.0" };
})();
