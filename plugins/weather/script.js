// Weather: "use my location". Slot html is injected after the page loads, so everything is delegated from the document.
//
// A bare "weather" or "forecast" (with no home location set on the server) renders a prompt card (.weather-card--prompt). This script
//  - shows the "Use my location" button only where the browser allows geolocation (a secure context: https or localhost), and the
//    typed-city field always; on plain http over a LAN address only the field and a one-line note are shown
//  - remembers the chosen place in this browser (localStorage, coordinates rounded to 2 decimals) and, on later searches, fills the
//    prompt card with the real weather card by itself (no click)
//  - asks the plugin's own route (<api>/card, address taken from the prompt card) for the card html: coordinates, or a typed place that
//    the server resolves. No third-party service is contacted from the browser.
// The pure helpers are at the top and are exported for the tests on globalThis.__degoogWeatherLocation.
(() => {
  const STORAGE_KEY = "degoog-ext:weather:location";
  const MAX_LABEL = 60;

  const round2 = (value) => Math.round(Number(value) * 100) / 100;
  const inRange = (value, limit) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
  const cleanLabel = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);

  // What is saved: { lat, lon, label?, query?, savedAt }. Anything else (or anything out of range) is not a saved place.
  const validSaved = (raw) => {
    if (!raw || typeof raw !== "object") return null;
    const numeric = (value) => (typeof value === "number" || (typeof value === "string" && value.trim() !== "") ? Number(value) : NaN);
    const lat = numeric(raw.lat);
    const lon = numeric(raw.lon);
    if (!inRange(lat, 90) || !inRange(lon, 180)) return null;
    const out = { lat: round2(lat), lon: round2(lon), savedAt: Number.isFinite(Number(raw.savedAt)) ? Number(raw.savedAt) : 0 };
    const label = cleanLabel(raw.label);
    if (label) out.label = label;
    const query = cleanLabel(raw.query);
    if (query) out.query = query;
    return out;
  };

  const readSaved = (storage) => {
    try {
      return validSaved(JSON.parse(storage.getItem(STORAGE_KEY)));
    } catch {
      return null;
    }
  };
  const writeSaved = (storage, entry) => {
    const saved = validSaved({ ...entry, savedAt: Date.now() });
    if (!saved) return false;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(saved));
      return true;
    } catch {
      return false;
    }
  };
  const clearSaved = (storage) => {
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to clear */
    }
  };

  // "geolocation": button and field; "city": field and a note (an insecure page, or a browser with no geolocation)
  const inputMode = ({ secure, hasGeolocation }) => (secure && hasGeolocation ? "geolocation" : "city");

  // The card route address with its query string, or "" when the pieces are not acceptable
  const cardUrl = (api, place) => {
    if (typeof api !== "string" || !/^\/api\/plugin\/[A-Za-z0-9._-]+\/card$/.test(api)) return "";
    const params = new URLSearchParams();
    if (place && Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lon)) && place.lat !== "" && place.lon !== "") {
      if (!inRange(Number(place.lat), 90) || !inRange(Number(place.lon), 180)) return "";
      params.set("lat", String(round2(place.lat)));
      params.set("lon", String(round2(place.lon)));
      const label = cleanLabel(place.label);
      if (label) params.set("label", label);
    } else if (place && typeof place.q === "string" && place.q.trim()) {
      params.set("q", place.q.trim().slice(0, 80));
    } else return "";
    return `${api}?${params.toString()}`;
  };

  const geoMessage = (code) =>
    code === 1 ? "Location permission was denied. Type a city instead." : code === 2 ? "Your position isn't available right now. Type a city instead." : code === 3 ? "Finding your position took too long. Type a city instead." : "Couldn't get your location. Type a city instead.";

  const statusMessage = (status) =>
    status === 404 ? "Couldn't find that place. Try “City, State” or “City, Country”." : status === 400 ? "That doesn't look like a place name." : "Weather isn't available right now. Try again in a minute.";

  globalThis.__degoogWeatherLocation = { STORAGE_KEY, round2, validSaved, readSaved, writeSaved, clearSaved, inputMode, cardUrl, geoMessage, statusMessage, cleanLabel };

  if (typeof document === "undefined" || typeof window === "undefined") return;
  if (window.__degoogWeatherScript) return;
  window.__degoogWeatherScript = true;

  const storage = () => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  };
  const busy = new WeakSet();

  const parts = (card) => ({
    body: card.querySelector(".weather-prompt-body"),
    loading: card.querySelector(".weather-loading"),
    locate: card.querySelector(".weather-locate"),
    note: card.querySelector(".weather-note"),
    input: card.querySelector(".weather-input"),
    status: card.querySelector(".weather-status"),
  });

  const setLoading = (card, on) => {
    const { body, loading } = parts(card);
    card.classList.toggle("is-loading", on);
    if (body) body.hidden = on;
    if (loading) loading.hidden = !on;
  };

  const problem = (card, text) => {
    setLoading(card, false);
    const { status } = parts(card);
    if (status) status.textContent = text;
  };

  // Asks the route for the card of `place` ({ lat, lon, label } or { q }) and swaps it in for the prompt card.
  const load = async (card, place) => {
    if (busy.has(card)) return;
    const url = cardUrl(card.dataset.api, place);
    if (!url) return problem(card, statusMessage(500));
    busy.add(card);
    setLoading(card, true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { headers: { Accept: "text/html" }, credentials: "same-origin", signal: controller.signal });
      if (!response.ok) {
        if (response.status === 400 && place.lat !== undefined) {
          const store = storage();
          if (store) clearSaved(store);
        }
        return problem(card, statusMessage(response.status));
      }
      const holder = document.createElement("template");
      holder.innerHTML = await response.text();
      const next = holder.content.querySelector(".weather-card");
      if (!next || !card.isConnected) return problem(card, statusMessage(500));
      const lat = Number(next.dataset.lat);
      const lon = Number(next.dataset.lon);
      const store = storage();
      if (store && Number.isFinite(lat) && Number.isFinite(lon)) writeSaved(store, { lat, lon, label: next.dataset.label || place.label, query: place.q });
      card.replaceWith(next);
    } catch {
      problem(card, statusMessage(0));
    } finally {
      clearTimeout(timer);
      busy.delete(card);
    }
  };

  const locate = (card) => {
    const { status } = parts(card);
    if (status) status.textContent = "";
    if (!window.isSecureContext || !navigator.geolocation) return problem(card, geoMessage(0));
    setLoading(card, true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = round2(position.coords.latitude);
        const lon = round2(position.coords.longitude);
        setLoading(card, false);
        load(card, { lat, lon });
      },
      (error) => problem(card, geoMessage(error && error.code)),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
    );
  };

  const saveTyped = (card) => {
    const { input, status } = parts(card);
    const text = input ? input.value.replace(/\s+/g, " ").trim() : "";
    if (!text) {
      if (status) status.textContent = "Type a city first.";
      return;
    }
    if (status) status.textContent = "";
    load(card, { q: text });
  };

  const setup = (card) => {
    if (card.dataset.ready === "true") return;
    card.dataset.ready = "true";
    const { locate: button, note } = parts(card);
    const mode = inputMode({ secure: window.isSecureContext === true, hasGeolocation: Boolean(navigator.geolocation) });
    if (button) button.hidden = mode !== "geolocation";
    if (note) note.hidden = mode === "geolocation";
    const store = storage();
    const saved = store ? readSaved(store) : null;
    // fill the card from the place saved in this browser; the prompt stays hidden meanwhile
    if (saved) load(card, { lat: saved.lat, lon: saved.lon, label: saved.label });
  };

  const scan = (root) => {
    const cards = root.querySelectorAll ? root.querySelectorAll(".weather-card--prompt") : [];
    cards.forEach(setup);
    if (root.matches && root.matches(".weather-card--prompt")) setup(root);
  };

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const locateButton = target.closest(".weather-locate");
    if (locateButton) {
      const card = locateButton.closest(".weather-card--prompt");
      if (card) locate(card);
      return;
    }
    const saveButton = target.closest(".weather-save");
    if (saveButton) {
      const card = saveButton.closest(".weather-card--prompt");
      if (card) saveTyped(card);
      return;
    }
    const change = target.closest(".weather-change");
    if (change) {
      event.preventDefault();
      const store = storage();
      if (store) clearSaved(store);
      window.location.reload();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !target.classList.contains("weather-input")) return;
    const card = target.closest(".weather-card--prompt");
    if (card) {
      event.preventDefault();
      saveTyped(card);
    }
  });

  new MutationObserver((records) => {
    for (const record of records) record.addedNodes.forEach((node) => node.nodeType === 1 && scan(node));
  }).observe(document.documentElement, { childList: true, subtree: true });
  scan(document);
})();
