// WMO weather codes (as Open-Meteo reports them) -> a description and an icon. Icons are inline SVG with currentColor strokes.

// code -> [text, icon kind]. Day/night only matters for clear and partly cloudy skies.
const CODES = {
  0: ["Clear", "clear"],
  1: ["Mainly clear", "clear"],
  2: ["Partly cloudy", "partly"],
  3: ["Overcast", "cloud"],
  45: ["Fog", "fog"],
  48: ["Freezing fog", "fog"],
  51: ["Light drizzle", "drizzle"],
  53: ["Drizzle", "drizzle"],
  55: ["Heavy drizzle", "drizzle"],
  56: ["Freezing drizzle", "sleet"],
  57: ["Heavy freezing drizzle", "sleet"],
  61: ["Light rain", "rain"],
  63: ["Rain", "rain"],
  65: ["Heavy rain", "rain"],
  66: ["Freezing rain", "sleet"],
  67: ["Heavy freezing rain", "sleet"],
  71: ["Light snow", "snow"],
  73: ["Snow", "snow"],
  75: ["Heavy snow", "snow"],
  77: ["Snow grains", "snow"],
  80: ["Light showers", "rain"],
  81: ["Showers", "rain"],
  82: ["Heavy showers", "rain"],
  85: ["Snow showers", "snow"],
  86: ["Heavy snow showers", "snow"],
  95: ["Thunderstorm", "thunder"],
  96: ["Thunderstorm with hail", "thunder"],
  99: ["Thunderstorm with heavy hail", "thunder"],
};

export const describeCode = (code, isDay = true) => {
  const entry = code === null || code === undefined || code === "" ? undefined : CODES[Number(code)];
  if (!entry) return { text: "Unknown", icon: "cloud", night: !isDay };
  const [text, icon] = entry;
  return { text, icon, night: !isDay };
};

const CLOUD = () => '<path d="M6.5 19h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 10.6a4.2 4.2 0 0 0 .4 8.4z"/>';
const SMALL_CLOUD = '<path d="M6.5 16h10.5a3.5 3.5 0 0 0 .5-6.96A5 5 0 0 0 7.2 8.7 3.7 3.7 0 0 0 6.5 16z"/>';

const SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>';
const MOON = '<path d="M20 14.2A8 8 0 0 1 9.8 4 8 8 0 1 0 20 14.2z"/>';
const PARTLY_DAY = '<circle cx="8" cy="8" r="2.6"/><path d="M8 2.5v1.2M2.5 8h1.2M4.1 4.1l.9.9M11.9 4.1l-.9.9"/><path d="M8 20h9.5a3.5 3.5 0 0 0 .5-6.96A5 5 0 0 0 8.5 12.7 3.7 3.7 0 0 0 8 20z"/>';
const PARTLY_NIGHT = '<path d="M11.2 8.6A3.6 3.6 0 0 1 6.4 3.8a3.6 3.6 0 1 0 4.8 4.8z"/><path d="M8 20h9.5a3.5 3.5 0 0 0 .5-6.96A5 5 0 0 0 8.5 12.7 3.7 3.7 0 0 0 8 20z"/>';

const ICONS = {
  clear: (night) => (night ? MOON : SUN),
  partly: (night) => (night ? PARTLY_NIGHT : PARTLY_DAY),
  cloud: () => CLOUD(),
  fog: () => '<path d="M3 8h18M5 12h14M3 16h18M7 20h10"/>',
  drizzle: () => `${SMALL_CLOUD}<path d="M8 19.5v.01M12 19.5v.01M16 19.5v.01M10 22v.01M14 22v.01"/>`,
  rain: () => `${SMALL_CLOUD}<path d="M8 18.5l-1 2.5M12 18.5l-1 2.5M16 18.5l-1 2.5"/>`,
  sleet: () => `${SMALL_CLOUD}<path d="M8 18.5l-1 2.5M16 18.5l-1 2.5M12 19.5v.01M12 22v.01"/>`,
  snow: () => `${SMALL_CLOUD}<path d="M8 19.5v.01M12 19.5v.01M16 19.5v.01M10 22v.01M14 22v.01"/>`,
  thunder: () => `${SMALL_CLOUD}<path d="M12.8 15.5l-2.3 3.2h3l-2 3.3"/>`,
};

// Icon kind (+ night) -> an <svg>. `size` is in px; the colour is the text colour.
export const iconSvg = (kind, night = false, size = 24, label = "") => {
  const draw = ICONS[kind] ?? ICONS.cloud;
  const aria = label ? `role="img" aria-label="${String(label).replace(/[&<>"']/g, "")}"` : 'aria-hidden="true"';
  return `<svg class="weather-icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${aria}>${draw(night)}</svg>`;
};

export const WMO_CODES = Object.keys(CODES).map(Number);
