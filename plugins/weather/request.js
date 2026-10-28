// Open-Meteo requests and replies. Only the URLs are built here; fetching, caching and pausing are the slot's job.
// Replies are normalised defensively: every number is coerced, anything unusable is dropped, nothing throws.

export const DEFAULT_FORECAST_BASE = "https://api.open-meteo.com";
export const DEFAULT_GEOCODING_BASE = "https://geocoding-api.open-meteo.com";
export const DEFAULT_AIR_BASE = "https://air-quality-api.open-meteo.com";

export const clean = (value, max = 80) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

const num = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const coordinate = (value, limit) => {
  const n = num(value);
  return n !== null && Math.abs(n) <= limit ? Math.round(n * 10_000) / 10_000 : null;
};

export const geocodeUrl = (base, name, count = 10) => {
  const url = new URL(`${base.replace(/\/+$/, "")}/v1/search`);
  url.searchParams.set("name", clean(name, 60));
  url.searchParams.set("count", String(Math.min(30, Math.max(1, count))));
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  return url.toString();
};

// units: "imperial" | "metric". Pressure and visibility have no unit parameter: they come in hPa and metres.
export const forecastUrl = (base, latitude, longitude, units) => {
  const imperial = units === "imperial";
  const url = new URL(`${base.replace(/\/+$/, "")}/v1/forecast`);
  const p = url.searchParams;
  p.set("latitude", String(latitude));
  p.set("longitude", String(longitude));
  p.set("current", "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility,uv_index");
  p.set("hourly", "temperature_2m,precipitation_probability,weather_code,is_day");
  p.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max");
  p.set("temperature_unit", imperial ? "fahrenheit" : "celsius");
  p.set("wind_speed_unit", imperial ? "mph" : "kmh");
  p.set("precipitation_unit", imperial ? "inch" : "mm");
  p.set("timezone", "auto");
  p.set("forecast_days", "7");
  return url.toString();
};

export const airUrl = (base, latitude, longitude) => {
  const url = new URL(`${base.replace(/\/+$/, "")}/v1/air-quality`);
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set("current", "us_aqi,pm2_5,pm10");
  url.searchParams.set("timezone", "auto");
  return url.toString();
};

const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// { results: [{ id, name, latitude, longitude, elevation, feature_code, country_code, admin1, admin2, population, timezone, country }] }
// "results" is absent when nothing was found.
export const parseGeocode = (text) => {
  const body = json(text);
  if (!body || typeof body !== "object") return null;
  const list = Array.isArray(body.results) ? body.results : [];
  const out = [];
  for (const item of list.slice(0, 40)) {
    if (!item || typeof item !== "object") continue;
    const lat = coordinate(item.latitude, 90);
    const lon = coordinate(item.longitude, 180);
    const name = clean(item.name, 80);
    if (lat === null || lon === null || !name) continue;
    out.push({
      name,
      lat,
      lon,
      admin1: clean(item.admin1, 80),
      admin2: clean(item.admin2, 80),
      country: clean(item.country, 80),
      countryCode: clean(item.country_code, 3).toUpperCase(),
      population: Math.max(0, num(item.population) ?? 0),
      feature: clean(item.feature_code, 8),
      timezone: clean(item.timezone, 60),
    });
  }
  return out;
};

const column = (object, key) => (object && Array.isArray(object[key]) ? object[key] : []);

// -> { timezone, abbreviation, current: {...}, hourly: [...], daily: [...] } or null when there is no usable temperature
export const parseForecast = (text) => {
  const body = json(text);
  if (!body || typeof body !== "object" || body.error) return null;
  const c = body.current;
  if (!c || typeof c !== "object") return null;
  const temp = num(c.temperature_2m);
  if (temp === null || typeof c.time !== "string") return null;
  const current = {
    time: clean(c.time, 20),
    temp,
    feels: num(c.apparent_temperature),
    humidity: num(c.relative_humidity_2m),
    isDay: c.is_day === 0 || c.is_day === false ? false : true,
    precip: num(c.precipitation),
    code: num(c.weather_code),
    pressure: num(c.pressure_msl),
    wind: num(c.wind_speed_10m),
    windDir: num(c.wind_direction_10m),
    gust: num(c.wind_gusts_10m),
    visibility: num(c.visibility),
    uv: num(c.uv_index),
  };
  const h = body.hourly;
  const hours = column(h, "time");
  const hourly = [];
  for (let i = 0; i < Math.min(hours.length, 400); i += 1) {
    const t = num(column(h, "temperature_2m")[i]);
    if (typeof hours[i] !== "string" || t === null) continue;
    hourly.push({ time: clean(hours[i], 20), temp: t, pop: num(column(h, "precipitation_probability")[i]), code: num(column(h, "weather_code")[i]), isDay: column(h, "is_day")[i] === 0 ? false : true });
  }
  const d = body.daily;
  const days = column(d, "time");
  const daily = [];
  for (let i = 0; i < Math.min(days.length, 16); i += 1) {
    const max = num(column(d, "temperature_2m_max")[i]);
    const min = num(column(d, "temperature_2m_min")[i]);
    if (typeof days[i] !== "string" || max === null || min === null) continue;
    daily.push({
      date: clean(days[i], 12),
      code: num(column(d, "weather_code")[i]),
      max,
      min,
      pop: num(column(d, "precipitation_probability_max")[i]),
      sunrise: typeof column(d, "sunrise")[i] === "string" ? clean(column(d, "sunrise")[i], 20) : "",
      sunset: typeof column(d, "sunset")[i] === "string" ? clean(column(d, "sunset")[i], 20) : "",
      uv: num(column(d, "uv_index_max")[i]),
    });
  }
  if (!daily.length) return null;
  return { timezone: clean(body.timezone, 60), abbreviation: clean(body.timezone_abbreviation, 10), current, hourly, daily };
};

// { current: { us_aqi, pm2_5, pm10 } }
export const parseAir = (text) => {
  const body = json(text);
  const c = body?.current;
  if (!c || typeof c !== "object") return null;
  const aqi = num(c.us_aqi);
  if (aqi === null || aqi < 0) return null;
  return { aqi: Math.round(aqi), pm25: num(c.pm2_5), pm10: num(c.pm10) };
};
