// Two small jobs, both on the document because slot html is injected after the page has loaded:
//  1. a team logo that fails to load is removed, which leaves the abbreviation badge underneath it
//  2. a card that shows a game in progress (data-live="true") asks for itself again every data-refresh seconds and swaps in the answer
//
// The refresh repeats the page's own request (POST api/slots with the original query) and replaces only the card. One timer for the
// whole page; it stops when the card leaves the page, the game is no longer live, the tab is hidden (it resumes when the tab is
// shown again), or after three failed refreshes in a row. The server keeps a live board in its cache for 20 seconds, so many open
// pages cost ESPN one request per cache window, not one each.
(() => {
  if (window.__degoogSportsScript) return;
  window.__degoogSportsScript = true;

  document.addEventListener(
    "error",
    (event) => {
      const target = event.target;
      if (target instanceof HTMLImageElement && target.classList.contains("sports-logo")) target.remove();
    },
    true,
  );

  const LIVE = '.sports-card[data-live="true"][data-query]';
  const MAX_FAILURES = 3;
  let timer = 0;
  let busy = false;
  let failures = 0;
  let controller = null;

  const liveCard = () => document.querySelector(LIVE);

  const stop = () => {
    clearTimeout(timer);
    timer = 0;
    if (controller) controller.abort();
    controller = null;
  };

  const headers = () => {
    const out = { "Content-Type": "application/json" };
    const auth = window.__DEGOOG_SEARCH_AUTH__;
    if (auth && typeof auth.n === "string" && typeof auth.s === "string") {
      out["x-search-nonce"] = auth.n;
      out["x-search-sig"] = auth.s;
    }
    return out;
  };

  const schedule = (delayMs) => {
    clearTimeout(timer);
    timer = 0;
    const card = liveCard();
    if (!card || failures >= MAX_FAILURES) return;
    const seconds = Math.max(15, Number.parseInt(card.dataset.refresh ?? "", 10) || 30);
    timer = setTimeout(tick, delayMs ?? seconds * 1000);
  };

  const tick = async () => {
    timer = 0;
    const card = liveCard();
    if (!card || busy) return;
    if (document.hidden) return;
    const query = card.dataset.query;
    busy = true;
    controller = new AbortController();
    let changed = false;
    try {
      const response = await fetch("api/slots", { method: "POST", headers: headers(), body: JSON.stringify({ query }), signal: controller.signal });
      if (!response.ok) throw new Error("refresh failed");
      const data = await response.json();
      const panels = Array.isArray(data?.panels) ? data.panels : [];
      const panel = panels.find((entry) => entry?.id === "sports-slot") ?? panels.find((entry) => typeof entry?.html === "string" && entry.html.includes("sports-card"));
      const holder = document.createElement("template");
      holder.innerHTML = typeof panel?.html === "string" ? panel.html : "";
      const next = holder.content.querySelector(".sports-card");
      if (!card.isConnected || card.dataset.query !== query) return;
      if (!next) {
        // the answer no longer has a card (for example upstream trouble): keep what is shown and try again later
        failures += 1;
        return;
      }
      failures = 0;
      card.replaceWith(next);
      changed = true;
    } catch (error) {
      if (error && error.name === "AbortError") return;
      failures += 1;
    } finally {
      busy = false;
      controller = null;
      if (!changed || liveCard()) schedule();
    }
  };

  const check = () => {
    if (!timer && !busy && failures < MAX_FAILURES && !document.hidden && liveCard()) schedule();
  };

  new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stop();
      return;
    }
    if (liveCard() && !busy) {
      failures = 0;
      schedule(1000);
    }
  });
  check();
})();
