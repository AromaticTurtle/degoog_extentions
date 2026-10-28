// Builds Open-Meteo-shaped replies from INVENTED numbers (a smooth day cycle and a made-up week). It is used by the weather tests
// and by tests/mock-weather-server.js; it is not a recording of anything. The layout (field names, arrays, units blocks) follows
// the Open-Meteo documentation: current / hourly / daily objects with parallel arrays, `timezone=auto` local ISO times.

const DAY_CODES = [2, 3, 61, 63, 80, 0, 1];
const MAX_C = [16, 14, 12, 11, 13, 17, 19];
const MIN_C = [8, 7, 6, 5, 6, 7, 9];
const POP = [10, 35, 70, 85, 55, 5, 0];

const pad = (n) => String(n).padStart(2, "0");
const addDays = (date, days) => {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};

// system: "imperial" | "metric". now: local "YYYY-MM-DDTHH:MM". Pressure is always hPa and visibility always metres, like the API.
export const buildForecast = ({ now = "2026-10-28T14:15", system = "metric", latitude = 48.85, longitude = 2.35, timezone = "Europe/Paris", abbreviation = "CET" } = {}) => {
  const imperial = system === "imperial";
  const temp = (c) => Math.round((imperial ? (c * 9) / 5 + 32 : c) * 10) / 10;
  const speed = (kmh) => Math.round((imperial ? kmh * 0.621371 : kmh) * 10) / 10;
  const startDate = now.slice(0, 10);
  const hourOfNow = Number(now.slice(11, 13));
  const hourly = { time: [], temperature_2m: [], precipitation_probability: [], weather_code: [], is_day: [] };
  for (let day = 0; day < 7; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const swing = Math.sin(((hour - 9) / 24) * 2 * Math.PI);
      const c = (MAX_C[day] + MIN_C[day]) / 2 + ((MAX_C[day] - MIN_C[day]) / 2) * swing;
      hourly.time.push(`${addDays(startDate, day)}T${pad(hour)}:00`);
      hourly.temperature_2m.push(temp(c));
      hourly.precipitation_probability.push(Math.max(0, Math.min(100, POP[day] + (hour % 5) * 3 - 6)));
      hourly.weather_code.push(DAY_CODES[day]);
      hourly.is_day.push(hour >= 7 && hour < 18 ? 1 : 0);
    }
  }
  const daily = { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_probability_max: [], sunrise: [], sunset: [], uv_index_max: [] };
  for (let day = 0; day < 7; day += 1) {
    const date = addDays(startDate, day);
    daily.time.push(date);
    daily.weather_code.push(DAY_CODES[day]);
    daily.temperature_2m_max.push(temp(MAX_C[day]));
    daily.temperature_2m_min.push(temp(MIN_C[day]));
    daily.precipitation_probability_max.push(POP[day]);
    daily.sunrise.push(`${date}T07:${pad(12 + day)}`);
    daily.sunset.push(`${date}T17:${pad(48 - day)}`);
    daily.uv_index_max.push([3.2, 2.1, 1.4, 1.1, 1.8, 3.6, 3.9][day]);
  }
  return {
    latitude,
    longitude,
    generationtime_ms: 0.4,
    utc_offset_seconds: 3600,
    timezone,
    timezone_abbreviation: abbreviation,
    elevation: 38,
    current_units: { time: "iso8601", interval: "seconds", temperature_2m: imperial ? "°F" : "°C", wind_speed_10m: imperial ? "mp/h" : "km/h", pressure_msl: "hPa", visibility: "m" },
    current: {
      time: now,
      interval: 900,
      temperature_2m: temp(15.2),
      relative_humidity_2m: 71,
      apparent_temperature: temp(13.9),
      is_day: hourOfNow >= 7 && hourOfNow < 18 ? 1 : 0,
      precipitation: imperial ? 0.01 : 0.2,
      weather_code: 2,
      pressure_msl: 1018.4,
      wind_speed_10m: speed(14.4),
      wind_direction_10m: 225,
      wind_gusts_10m: speed(28.1),
      visibility: 24100,
      uv_index: 2.3,
    },
    hourly_units: { time: "iso8601", temperature_2m: imperial ? "°F" : "°C", precipitation_probability: "%" },
    hourly,
    daily_units: { time: "iso8601", temperature_2m_max: imperial ? "°F" : "°C" },
    daily,
  };
};

export const buildAir = ({ aqi = 42 } = {}) => ({
  latitude: 48.85,
  longitude: 2.35,
  utc_offset_seconds: 3600,
  timezone: "Europe/Paris",
  current_units: { time: "iso8601", us_aqi: "USD AQI", pm10: "μg/m³", pm2_5: "μg/m³" },
  current: { time: "2026-10-28T14:00", interval: 3600, us_aqi: aqi, pm10: 14.2, pm2_5: 8.1 },
});
