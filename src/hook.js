// roda no contexto da própria página, antes do maps carregar, pra ver as
// respostas de /search?tbm=map que ele mesmo baixa. não faz requisição nenhuma.
(() => {
  if (window.__prospectaHook) return;
  window.__prospectaHook = true;

  const isBatch = (url) => typeof url === "string" && url.includes("tbm=map");
  // o primeiro lote chega antes do content script; guarda até ele avisar que está pronto
  let ready = false;
  const buffer = [];
  const post = (m) => {
    try {
      window.postMessage(m, location.origin);
    } catch {}
  };
  const send = (url, body) => {
    const m = { source: "prospecta-hook", url, body };
    if (ready) post(m);
    else buffer.push(m);
  };
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.source !== "prospecta-ready") return;
    ready = true;
    buffer.splice(0).forEach(post);
  });

  const open = XMLHttpRequest.prototype.open;
  const xsend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__prspUrl = String(url);
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (isBatch(this.__prspUrl)) {
      this.addEventListener("load", () => {
        try {
          if (this.responseType === "" || this.responseType === "text") send(this.__prspUrl, this.responseText);
        } catch {}
      });
    }
    return xsend.apply(this, arguments);
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === "string" ? input : input?.url;
      if (isBatch(url)) p.then((r) => r.clone().text().then((t) => send(url, t))).catch(() => {});
    } catch {}
    return p;
  };
})();
