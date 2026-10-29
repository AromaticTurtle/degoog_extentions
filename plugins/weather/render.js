import { aqiCategory, currentHourIndex, dayName, fmtClock, fmtHour, fmtPercent, fmtPressure, fmtPrecip, fmtTemp, fmtUv, fmtVisibility, fmtWind, percentOf } from "./format.js";
import { describeCode, iconSvg } from "./wmo.js";

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const OPEN_METEO_URL = "https://open-meteo.com";
export const LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";

const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;

const attribution = () => `Weather data by ${link(OPEN_METEO_URL, "Open-Meteo.com")} · ${link(LICENSE_URL, "CC BY 4.0")}`;

const rangeBar = (low, high, min, max, label) => {
  const left = percentOf(low, min, max);
  const right = percentOf(high, min, max);
  const width = Math.max(4, right - left);
  const x = Math.min(left, 100 - width);
  return `<svg class="weather-range" viewBox="0 0 100 4" preserveAspectRatio="none" role="img" aria-label="${esc(label)}" width="100%" height="4"><rect class="weather-range-track" width="100" height="4" rx="2"/><rect class="weather-range-fill" x="${x.toFixed(1)}" width="${width.toFixed(1)}" height="4" rx="2"/></svg>`;
};

const cell = (value, label) => `<div class="weather-cell"><span class="weather-cell-value">${esc(value)}</span><span class="weather-cell-label">${esc(label)}</span></div>`;

const hourlyStrip = (forecast, units) => {
  const start = currentHourIndex(forecast.hourly, forecast.current.time);
  const hours = forecast.hourly.slice(start, start + 24);
  if (!hours.length) return "";
  const items = hours
    .map((hour, index) => {
      const d = describeCode(hour.code, hour.isDay);
      const pop = Number.isFinite(hour.pop) && hour.pop >= 10 ? fmtPercent(hour.pop) : "";
      return `<li class="weather-hour"><span class="weather-hour-time">${index === 0 ? "Now" : esc(fmtHour(hour.time, units.hour12))}</span>${iconSvg(d.icon, d.night, 24, d.text)}<span class="weather-hour-temp">${esc(fmtTemp(hour.temp))}</span><span class="weather-hour-pop">${esc(pop)}</span></li>`;
    })
    .join("");
  return `<div class="weather-section-label">Next 24 hours</div><ul class="weather-hours">${items}</ul>`;
};

const dayList = (forecast) => {
  const days = forecast.daily.slice(0, 7);
  const min = Math.min(...days.map((d) => d.min));
  const max = Math.max(...days.map((d) => d.max));
  const rows = days
    .map((day, index) => {
      const d = describeCode(day.code, true);
      const pop = Number.isFinite(day.pop) && day.pop >= 10 ? fmtPercent(day.pop) : "";
      return `<li class="weather-day"><span class="weather-day-name">${index === 0 ? "Today" : esc(dayName(day.date))}</span>${iconSvg(d.icon, false, 24, d.text)}<span class="weather-day-pop">${esc(pop)}</span><span class="weather-day-lo">${esc(fmtTemp(day.min))}</span>${rangeBar(day.min, day.max, min, max, `${fmtTemp(day.min)} to ${fmtTemp(day.max)}`)}<span class="weather-day-hi">${esc(fmtTemp(day.max))}</span></li>`;
    })
    .join("");
  return `<div class="weather-section-label">${days.length}-day forecast</div><ul class="weather-days">${rows}</ul>`;
};

const aqiRow = (air) => {
  if (!air) return "";
  const { label, key } = aqiCategory(air.aqi);
  return `<div class="weather-aqi"><svg class="weather-aqi-dot weather-aqi-dot--${key}" viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><circle cx="4" cy="4" r="4"/></svg><span class="weather-aqi-value">${esc(air.aqi)}</span><span class="weather-aqi-label">Air quality (US AQI) · ${esc(label)}</span></div>`;
};

const PIN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-6-5.2-6-10a6 6 0 1 1 12 0c0 4.8-6 10-6 10z"/><circle cx="12" cy="11" r="2"/></svg>';

// -> html. `data`: { label, forecast, air, units, place?: { lat, lon } }. layout: "inline" (detailed) or "panel" (compact).
// A card made for a place the browser saved (place) carries its coordinates and label, so the page script can remember them, and a
// "Change location" link.
export const buildCard = (data, { layout = "inline", changeLink = false } = {}) => {
  const { label, forecast, air, units, place } = data;
  const placeAttrs = place ? ` data-lat="${esc(place.lat)}" data-lon="${esc(place.lon)}" data-label="${esc(label)}"` : "";
  const change = changeLink ? ` · <a class="weather-link weather-change" href="#">Change location</a>` : "";
  const now = forecast.current;
  const today = forecast.daily[0];
  const d = describeCode(now.code, now.isDay);
  const kicker = `<div class="weather-kicker">Weather · ${esc(label)}</div>`;
  const feels = Number.isFinite(now.feels) ? `Feels like ${fmtTemp(now.feels)}` : "";
  const highLow = `H ${fmtTemp(today.max)} · L ${fmtTemp(today.min)}`;
  const footer = (updated) => `<div class="weather-footer">${updated ? `Updated ${esc(updated)} · ` : ""}${attribution()}${change}</div>`;
  const updated = fmtClock(now.time, units.hour12);

  if (layout === "panel") {
    const days = forecast.daily.slice(0, 5);
    const strip = days
      .map((day, index) => {
        const dd = describeCode(day.code, true);
        return `<li class="weather-mini"><span class="weather-mini-name">${index === 0 ? "Today" : esc(dayName(day.date))}</span>${iconSvg(dd.icon, false, 22, dd.text)}<span class="weather-mini-hi">${esc(fmtTemp(day.max))}</span><span class="weather-mini-lo">${esc(fmtTemp(day.min))}</span></li>`;
      })
      .join("");
    return `<div class="weather-card weather-card--panel"${placeAttrs}>${kicker}<div class="weather-now"><div class="weather-now-main">${iconSvg(d.icon, d.night, 44, d.text)}<span class="weather-temp">${esc(fmtTemp(now.temp).replace("°", ""))}<span class="weather-temp-unit">${esc(units.temp)}</span></span></div><div class="weather-cond">${esc(d.text)}</div></div><div class="weather-sub">${esc([highLow, feels].filter(Boolean).join(" · "))}</div><ul class="weather-minis">${strip}</ul>${footer("")}</div>`;
  }

  const cells = [
    cell(fmtWind(now.wind, now.windDir, units), "Wind"),
    cell(fmtPercent(now.humidity), "Humidity"),
    cell(fmtPressure(now.pressure, units), "Pressure"),
    cell(fmtVisibility(now.visibility, units), "Visibility"),
    cell(fmtUv(now.uv), "UV index"),
    cell(fmtPercent(today.pop), "Precipitation"),
    cell(fmtClock(today.sunrise, units.hour12), "Sunrise"),
    cell(fmtClock(today.sunset, units.hour12), "Sunset"),
  ];
  if (Number.isFinite(now.precip) && now.precip > 0) cells.splice(6, 0, cell(fmtPrecip(now.precip, units), "Precip. now"));
  const head = `<div class="weather-now"><div class="weather-now-main">${iconSvg(d.icon, d.night, 56, d.text)}<span class="weather-temp">${esc(fmtTemp(now.temp).replace("°", ""))}<span class="weather-temp-unit">${esc(units.temp)}</span></span></div><div class="weather-now-text"><div class="weather-cond">${esc(d.text)}</div><div class="weather-sub">${esc([feels, highLow].filter(Boolean).join(" · "))}</div></div></div>`;
  return `<div class="weather-card weather-card--inline"${placeAttrs}>${kicker}${head}<div class="weather-grid">${cells.join("")}</div>${aqiRow(air)}${hourlyStrip(forecast, units)}${dayList(forecast)}${footer(updated)}</div>`;
};

// The card shown for a bare "weather" when no place is known yet. The page script (script.js) shows the "Use my location" button only
// where the browser allows geolocation (a secure context), fills the card from the place saved in this browser, or from the
// city typed here. `message` replaces the sentence (for example when the home location setting could not be found).
export const buildPrompt = ({ layout = "inline", api = "/api/plugin/weather", message = "" } = {}) => {
  const text = message ? `<p class="weather-prompt-text weather-prompt-text--problem">${esc(message)}</p>` : `<p class="weather-prompt-text">Show the weather for where you are. The place stays in this browser.</p>`;
  return `<div class="weather-card weather-card--prompt weather-card--${layout === "panel" ? "panel" : "inline"}" data-api="${esc(`${api}/card`)}"><div class="weather-kicker">Weather · Your location</div><div class="weather-prompt-body">${text}<button type="button" class="weather-locate" hidden>${PIN}<span>Use my location</span></button><div class="weather-city"><input class="weather-input" type="text" maxlength="80" autocomplete="off" spellcheck="false" placeholder="City, e.g. Charlotte, NC" aria-label="City"><button type="button" class="weather-save">Save</button></div><p class="weather-note" hidden>Browser location needs HTTPS; type a city instead.</p><p class="weather-status" role="status" aria-live="polite"></p></div><div class="weather-loading" hidden>Loading weather…</div></div>`;
};
