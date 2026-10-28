// Number and time formatting for the weather card. Pure.

export const unitsFor = (system) =>
  system === "metric"
    ? { system: "metric", temp: "°C", wind: "km/h", pressure: "hPa", visibility: "km", precip: "mm", hour12: false }
    : { system: "imperial", temp: "°F", wind: "mph", pressure: "inHg", visibility: "mi", precip: "in", hour12: true };

export const fmtTemp = (value) => (Number.isFinite(value) ? `${Math.round(value) === 0 ? 0 : Math.round(value)}°` : "–");

const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export const compass = (degrees) => (Number.isFinite(degrees) ? POINTS[Math.round((((degrees % 360) + 360) % 360) / 45) % 8] : "");

export const fmtWind = (speed, degrees, units) => {
  if (!Number.isFinite(speed)) return "–";
  const dir = compass(degrees);
  return `${Math.round(speed)} ${units.wind}${dir ? ` ${dir}` : ""}`;
};

// The API always reports pressure in hPa
export const fmtPressure = (hpa, units) => {
  if (!Number.isFinite(hpa)) return "–";
  return units.system === "imperial" ? `${(hpa * 0.02953).toFixed(2)} inHg` : `${Math.round(hpa)} hPa`;
};

// ... and visibility in metres
export const fmtVisibility = (metres, units) => {
  if (!Number.isFinite(metres)) return "–";
  const value = units.system === "imperial" ? metres / 1609.344 : metres / 1000;
  // anything beyond 10 miles (16 km) is just "clear": the API reports up to 100+ km on a good day
  const cap = units.system === "imperial" ? 10 : 16;
  if (value >= cap) return `${cap}+ ${units.visibility}`;
  return `${Math.round(value * 10) / 10} ${units.visibility}`;
};

export const fmtPrecip = (value, units) => {
  if (!Number.isFinite(value)) return "–";
  return `${units.system === "imperial" ? value.toFixed(2) : value.toFixed(1)} ${units.precip}`;
};

export const fmtPercent = (value) => (Number.isFinite(value) ? `${Math.round(value)}%` : "–");

export const uvLabel = (uv) => {
  if (!Number.isFinite(uv)) return "";
  if (uv < 3) return "Low";
  if (uv < 6) return "Moderate";
  if (uv < 8) return "High";
  if (uv < 11) return "Very high";
  return "Extreme";
};

export const fmtUv = (uv) => (Number.isFinite(uv) ? `${Math.round(uv * 10) / 10} ${uvLabel(uv)}`.trim() : "–");

// US AQI: [upper bound, category, scoped colour class]
const AQI = [
  [50, "Good", "good"],
  [100, "Moderate", "moderate"],
  [150, "Unhealthy for sensitive groups", "sensitive"],
  [200, "Unhealthy", "unhealthy"],
  [300, "Very unhealthy", "very"],
  [Infinity, "Hazardous", "hazardous"],
];
export const aqiCategory = (aqi) => {
  const [, label, key] = AQI.find(([max]) => aqi <= max);
  return { label, key };
};

// "2026-10-28T14:15" (local to the place) -> "2:15 PM" or "14:15"
const parts = (iso) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(iso ?? ""));
  return match ? { y: +match[1], m: +match[2], d: +match[3], h: match[4] === undefined ? null : +match[4], min: match[5] === undefined ? 0 : +match[5] } : null;
};

export const fmtClock = (iso, hour12) => {
  const p = parts(iso);
  if (!p || p.h === null) return "–";
  const mm = String(p.min).padStart(2, "0");
  if (!hour12) return `${String(p.h).padStart(2, "0")}:${mm}`;
  return `${p.h % 12 === 0 ? 12 : p.h % 12}:${mm} ${p.h < 12 ? "AM" : "PM"}`;
};

// "3 PM" / "15:00"; "12 AM" shows the next day name instead where the caller wants it
export const fmtHour = (iso, hour12) => {
  const p = parts(iso);
  if (!p || p.h === null) return "";
  if (!hour12) return `${String(p.h).padStart(2, "0")}:00`;
  return `${p.h % 12 === 0 ? 12 : p.h % 12} ${p.h < 12 ? "AM" : "PM"}`;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const dayName = (date) => {
  const p = parts(date);
  if (!p) return "";
  return DAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()];
};

// Where the place's current hour is in the hourly list: the last entry not after "now" (local times compare as text).
export const currentHourIndex = (hourly, nowIso) => {
  let index = 0;
  for (let i = 0; i < hourly.length; i += 1) {
    if (hourly[i].time <= nowIso) index = i;
    else break;
  }
  return index;
};

// Position (0..100) of `value` between `low` and `high`; 50 when the range has no width
export const percentOf = (value, low, high) => {
  const span = high - low;
  if (!(span > 0)) return 50;
  return Math.min(100, Math.max(0, ((value - low) / span) * 100));
};
