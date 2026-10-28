// Tests for the weather slot plugin: query grammar, place disambiguation, WMO codes, units, Open-Meteo requests, caching, pauses,
// cards, layout and settings.
//
// NOTE: tests/fixtures/open-meteo-geocode.json is HAND-WRITTEN (place names are real, the ids and populations are rounded or
// invented) and tests/fixtures/open-meteo-builder.js builds forecasts from INVENTED numbers in Open-Meteo's documented layout.
// Nothing here is a recording.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildAir, buildForecast } from "./fixtures/open-meteo-builder.js";
import { Budget } from "../plugins/weather/budget.js";
import { aqiCategory, compass, currentHourIndex, dayName, fmtClock, fmtHour, fmtPressure, fmtTemp, fmtUv, fmtVisibility, fmtWind, percentOf, unitsFor, uvLabel } from "../plugins/weather/format.js";
import { parseQuery } from "../plugins/weather/match.js";
import { norm, pickPlace, placeLabel, splitPlace } from "../plugins/weather/places.js";
import { airUrl, forecastUrl, geocodeUrl, parseAir, parseForecast, parseGeocode } from "../plugins/weather/request.js";
import { buildCard, buildHint } from "../plugins/weather/render.js";
import { SETTINGS_SCHEMA } from "../plugins/weather/settings.js";
import { WMO_CODES, describeCode, iconSvg } from "../plugins/weather/wmo.js";
import { INLINE_POSITION, PANEL_POSITION, USER_AGENT, WeatherSlot, command, homeFrom, layoutFrom, slot as sharedSlot, unitsFrom } from "../plugins/weather/index.js";

const GEO = JSON.parse(readFileSync(new URL("./fixtures/open-meteo-geocode.json", import.meta.url), "utf8"));

const world = (overrides = {}) => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: String(url), path: u.pathname, params: u.searchParams, headers: init.headers ?? {} });
    const kind = u.pathname === "/v1/search" ? "geo" : u.pathname === "/v1/forecast" ? "forecast" : u.pathname === "/v1/air-quality" ? "air" : "other";
    const handler = overrides[kind];
    if (handler) {
      const custom = await handler(u, calls.length);
      if (custom) return custom;
    }
    if (kind === "geo") {
      const results = GEO[u.searchParams.get("name").toLowerCase()];
      return new Response(JSON.stringify(results ? { results } : { generationtime_ms: 0.2 }), { status: 200 });
    }
    if (kind === "forecast") return new Response(JSON.stringify(buildForecast({ system: u.searchParams.get("temperature_unit") === "fahrenheit" ? "imperial" : "metric" })), { status: 200 });
    if (kind === "air") return new Response(JSON.stringify(buildAir()), { status: 200 });
    return new Response("nope", { status: 404 });
  };
  const count = (kind) => calls.filter((c) => (kind === "geo" ? c.path === "/v1/search" : kind === "forecast" ? c.path === "/v1/forecast" : c.path === "/v1/air-quality")).length;
  return { fetch, calls, count };
};

const clock = (start = Date.parse("2026-10-28T12:00:00Z")) => {
  const state = { t: start };
  return { state, now: () => state.t, sleep: async (ms) => { state.t += ms; } };
};

const makeSlot = (settings = {}, { time } = {}) => {
  const slot = new WeatherSlot();
  slot.spacingMs = 0;
  slot.budget.file = "";
  if (time) {
    slot.now = time.now;
    slot.sleep = time.sleep;
  }
  slot.configure(settings);
  return slot;
};

const capture = async (work) => {
  const lines = [];
  const original = { info: console.info, warn: console.warn, log: console.log, error: console.error };
  for (const level of ["info", "warn", "log", "error"]) console[level] = (...args) => lines.push(args.join(" "));
  try {
    await work();
  } finally {
    Object.assign(console, original);
  }
  return lines;
};

const parsedOf = (query) => {
  const { parsed } = parseQuery(query);
  return parsed ? { place: parsed.place, home: parsed.home, bare: parsed.bare } : null;
};

describe("which queries are weather questions", () => {
  const positives = [
    ["weather", "", true, true],
    ["Weather", "", true, true],
    ["forecast", "", true, true],
    ["the weather", "", true, true],
    ["weather today", "", true, true],
    ["weather forecast", "", true, true],
    ["weather tomorrow", "", true, true],
    ["weather near me", "", true, false],
    ["weather here", "", true, false],
    ["weather in paris", "paris", false, false],
    ["weather in Paris, Texas", "paris, texas", false, false],
    ["weather for seattle", "seattle", false, false],
    ["weather seattle", "seattle", false, false],
    ["seattle weather", "seattle", false, false],
    ["seattle weather today", "seattle", false, false],
    ["seattle weather forecast", "seattle", false, false],
    ["seattle forecast", "seattle", false, false],
    ["forecast seattle", "seattle", false, false],
    ["forecast for seattle", "seattle", false, false],
    ["forecast for seattle this week", "seattle", false, false],
    ["weather in new york city tomorrow", "new york city", false, false],
    ["weather in st. louis, mo", "st. louis, mo", false, false],
    ["paris texas weather", "paris texas", false, false],
    ["portland maine weather", "portland maine", false, false],
    ["springfield il weather", "springfield il", false, false],
    ["london ontario weather", "london ontario", false, false],
    ["charlotte nc weather", "charlotte nc", false, false],
    ["what's the weather in seattle", "seattle", false, false],
    ["what is the weather like in seattle", "seattle", false, false],
    ["how's the weather in seattle?", "seattle", false, false],
    ["temperature in seattle", "seattle", false, false],
    ["current temperature in seattle", "seattle", false, false],
    ["what is the temperature in seattle", "seattle", false, false],
    ["temp in seattle", "seattle", false, false],
    ["is it raining in seattle", "seattle", false, false],
    ["is it snowing in oslo", "oslo", false, false],
    ["will it rain in seattle tomorrow", "seattle", false, false],
    ["will it snow in denver", "denver", false, false],
    ["is it going to rain in london", "london", false, false],
    ["how cold is it in oslo", "oslo", false, false],
    ["how hot is it in phoenix?", "phoenix", false, false],
    ["weather São Paulo", "são paulo", false, false],
    ["weather in zürich", "zürich", false, false],
    ["7 day forecast seattle", "seattle", false, false],
    ["seattle 10-day forecast", "seattle", false, false],
  ];
  for (const [query, place, home, bare] of positives) {
    test(`${query} => place "${place}"${home ? " (home)" : ""}`, () => expect(parsedOf(query)).toEqual({ place, home, bare }));
  }

  test("a question with no place uses the home location", () => {
    expect(parsedOf("is it raining")).toEqual({ place: "", home: true, bare: false });
    expect(parsedOf("will it snow tomorrow")).toEqual({ place: "", home: true, bare: false });
    expect(parsedOf("how cold is it")).toEqual({ place: "", home: true, bare: false });
  });

  const negatives = [
    "", " ", "paris", "seattle", "rain", "snow", "storm", "temperature", "temp", "weather the storm", "weather app", "weather radar", "weather channel", "weather station", "weather underground",
    "weather balloon", "weather vane", "weather map", "space weather", "bad weather", "good weather", "severe weather", "winter weather", "fair weather friend", "sales forecast", "economic forecast",
    "stock forecast", "bitcoin forecast", "nfl forecast", "fantasy forecast", "price forecast", "revenue forecast", "weather in", "weather the", "weather is nice", "is it raining men",
    "will it rain on my parade", "2+2", "100 usd to eur", "define weather", "weather meaning", "the weather girls", "weather report news", "how is the weather app", "https://weather.example.com",
    "me@weather.com", "weather 2+2", "x".repeat(150), "weather " + "a ".repeat(30), "weather in <script>", "weather in paris$$$", "who forecast", "what is a forecast", "forecast model",
  ];
  for (const query of negatives) test(`not a weather question: ${JSON.stringify(query.slice(0, 40))}`, () => expect(parsedOf(query), query).toBeNull());

  test("never throws", () => {
    for (const query of [null, undefined, 5, {}, "\u0000", "weather \u0000", "💥 weather", "weather in " + "é".repeat(30)]) expect(() => parseQuery(query)).not.toThrow();
  });
});

describe("places: splitting and disambiguation", () => {
  const pick = (text) => {
    const split = splitPlace(text);
    const results = parseGeocode(JSON.stringify({ results: GEO[norm(split.name)] ?? [] }));
    return pickPlace(results, split);
  };
  const label = (text) => {
    const { place } = pick(text);
    return place ? placeLabel(place) : null;
  };

  test("splitting", () => {
    expect(splitPlace("paris texas")).toMatchObject({ name: "paris", hint: "texas", kind: "region" });
    expect(splitPlace("paris tx")).toMatchObject({ name: "paris", hint: "tx", kind: "region" });
    expect(splitPlace("Charlotte, NC")).toMatchObject({ name: "Charlotte", hint: "NC", kind: "region" });
    expect(splitPlace("london united kingdom")).toMatchObject({ name: "london", hint: "united kingdom" });
    expect(splitPlace("paris fr")).toMatchObject({ name: "paris", hint: "fr", kind: "soft" });
    expect(splitPlace("paris, nowhereland")).toMatchObject({ name: "paris", hint: "nowhereland", kind: "soft" });
    expect(splitPlace("london")).toMatchObject({ name: "london", hint: "" });
    expect(splitPlace("new york")).toMatchObject({ name: "new york", hint: "" });
    expect(splitPlace("new mexico")).toMatchObject({ name: "new mexico", hint: "" });
    expect(splitPlace("west virginia")).toMatchObject({ name: "west virginia", hint: "" });
    expect(splitPlace("kansas city mo")).toMatchObject({ name: "kansas city", hint: "mo" });
    expect(splitPlace("washington dc")).toMatchObject({ name: "washington", hint: "dc" });
    expect(splitPlace("new south wales")).toMatchObject({ hint: "" });
    expect(splitPlace("  ")).toMatchObject({ name: "", hint: "" });
  });

  test("without a hint the most populated place wins", () => {
    expect(label("paris")).toBe("Paris, Île-de-France, France");
    expect(label("springfield")).toBe("Springfield, Missouri, United States");
    expect(label("portland")).toBe("Portland, Oregon, United States");
    expect(label("london")).toBe("London, England, United Kingdom");
    expect(label("charlotte")).toBe("Charlotte, North Carolina, United States");
    expect(label("washington")).toBe("Washington, District of Columbia, United States");
  });

  test("a state or province (name or abbreviation) decides", () => {
    expect(label("paris texas")).toBe("Paris, Texas, United States");
    expect(label("paris tx")).toBe("Paris, Texas, United States");
    expect(label("paris, TX")).toBe("Paris, Texas, United States");
    expect(label("paris tennessee")).toBe("Paris, Tennessee, United States");
    expect(label("paris ontario")).toBe("Paris, Ontario, Canada");
    expect(label("paris on")).toBe("Paris, Ontario, Canada");
    expect(label("springfield il")).toBe("Springfield, Illinois, United States");
    expect(label("springfield massachusetts")).toBe("Springfield, Massachusetts, United States");
    expect(label("springfield ma")).toBe("Springfield, Massachusetts, United States");
    expect(label("portland maine")).toBe("Portland, Maine, United States");
    expect(label("portland me")).toBe("Portland, Maine, United States");
    expect(label("london ontario")).toBe("London, Ontario, Canada");
    expect(label("london on")).toBe("London, Ontario, Canada");
    expect(label("charlotte nc")).toBe("Charlotte, North Carolina, United States");
    expect(label("charlotte vt")).toBe("Charlotte, Vermont, United States");
    expect(label("washington dc")).toBe("Washington, District of Columbia, United States");
    expect(label("washington nc")).toBe("Washington, North Carolina, United States");
  });

  test("a country (name or code) decides", () => {
    expect(label("paris france")).toBe("Paris, Île-de-France, France");
    expect(label("paris fr")).toBe("Paris, Île-de-France, France");
    expect(label("paris us")).toBe("Paris, Texas, United States");
    expect(label("paris usa")).toBe("Paris, Texas, United States");
    expect(label("london uk")).toBe("London, England, United Kingdom");
    expect(label("london canada")).toBe("London, Ontario, Canada");
    expect(label("london ca")).toBe("London, Ontario, Canada");
    expect(label("portland australia")).toBe("Portland, Victoria, Australia");
  });

  test("a hint that matches nothing: a known region means no place, an unknown one is ignored", () => {
    expect(pick("paris kansas").place).toBeNull();
    expect(pick("paris kansas").reason).toContain("kansas");
    expect(label("paris xx")).toBe("Paris, Île-de-France, France");
    expect(label("paris, nowhereland")).toBe("Paris, Île-de-France, France");
  });

  test("results without any match, empty lists and odd shapes", () => {
    expect(pickPlace([], splitPlace("zzzz")).place).toBeNull();
    expect(pickPlace(null, splitPlace("zzzz")).place).toBeNull();
    expect(pickPlace(undefined, { name: "", hint: "" }).place).toBeNull();
    const fuzzy = pickPlace(parseGeocode(JSON.stringify({ results: GEO.quillfordshire })), splitPlace("quillfordshir"));
    expect(fuzzy.place.name).toBe("Quillfordshire");
    expect(fuzzy.reason).toContain("closest");
  });

  test("diacritics and punctuation do not matter", () => {
    expect(norm("Île-de-France")).toBe("ile-de-france");
    expect(norm("St. Louis")).toBe("st louis");
    expect(label("PARIS TEXAS")).toBe("Paris, Texas, United States");
  });

  test("the label repeats nothing", () => {
    expect(placeLabel({ name: "Singapore", admin1: "Singapore", country: "Singapore" })).toBe("Singapore");
    expect(placeLabel({ name: "X", admin1: "", country: "Y" })).toBe("X, Y");
  });
});

describe("WMO codes", () => {
  test("every code the API can send has a text and an icon", () => {
    expect(WMO_CODES.length).toBeGreaterThanOrEqual(27);
    for (const code of WMO_CODES) {
      const day = describeCode(code, true);
      const night = describeCode(code, false);
      expect(day.text.length).toBeGreaterThan(2);
      expect(day.icon).toBeTruthy();
      expect(night.night).toBe(true);
      expect(iconSvg(day.icon, false)).toContain("<svg");
    }
  });
  test("the usual suspects", () => {
    expect(describeCode(0, true)).toMatchObject({ text: "Clear", icon: "clear", night: false });
    expect(describeCode(0, false)).toMatchObject({ icon: "clear", night: true });
    expect(describeCode(2).icon).toBe("partly");
    expect(describeCode(3).icon).toBe("cloud");
    expect(describeCode(45).icon).toBe("fog");
    expect(describeCode(53).icon).toBe("drizzle");
    expect(describeCode(63).icon).toBe("rain");
    expect(describeCode(66).icon).toBe("sleet");
    expect(describeCode(73).icon).toBe("snow");
    expect(describeCode(81).icon).toBe("rain");
    expect(describeCode(86).icon).toBe("snow");
    expect(describeCode(95).icon).toBe("thunder");
    expect(describeCode(99).text).toContain("hail");
  });
  test("unknown or missing codes fall back to a cloud", () => {
    for (const code of [null, undefined, "x", 1234, -1]) expect(describeCode(code).icon).toBe("cloud");
  });
  test("day and night icons differ for clear and partly cloudy skies", () => {
    expect(iconSvg("clear", false)).not.toBe(iconSvg("clear", true));
    expect(iconSvg("partly", false)).not.toBe(iconSvg("partly", true));
    expect(iconSvg("rain", false)).toBe(iconSvg("rain", true));
  });
  test("icons are currentColor strokes with no inline style, and the label is safe", () => {
    const svg = iconSvg("rain", false, 24, 'x"><script>');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).not.toContain("style=");
    expect(svg).not.toContain("<script");
    expect(iconSvg("rain")).toContain('aria-hidden="true"');
  });
});

describe("units and formatting", () => {
  const imperial = unitsFor("imperial");
  const metric = unitsFor("metric");
  test("unit sets", () => {
    expect(imperial).toMatchObject({ temp: "°F", wind: "mph", pressure: "inHg", visibility: "mi", precip: "in", hour12: true });
    expect(metric).toMatchObject({ temp: "°C", wind: "km/h", pressure: "hPa", visibility: "km", precip: "mm", hour12: false });
    expect(unitsFor("anything").system).toBe("imperial");
  });
  test("temperature", () => {
    expect(fmtTemp(72.4)).toBe("72°");
    expect(fmtTemp(-0.4)).toBe("0°");
    expect(fmtTemp(-3.6)).toBe("-4°");
    expect(fmtTemp(null)).toBe("–");
    expect(fmtTemp(Number.NaN)).toBe("–");
  });
  test("wind and compass", () => {
    expect(compass(0)).toBe("N");
    expect(compass(225)).toBe("SW");
    expect(compass(359)).toBe("N");
    expect(compass(-45)).toBe("NW");
    expect(compass(null)).toBe("");
    expect(fmtWind(8.6, 225, imperial)).toBe("9 mph SW");
    expect(fmtWind(14.4, 90, metric)).toBe("14 km/h E");
    expect(fmtWind(null, 90, metric)).toBe("–");
    expect(fmtWind(5, null, metric)).toBe("5 km/h");
  });
  test("pressure, visibility", () => {
    expect(fmtPressure(1018.4, imperial)).toBe("30.07 inHg");
    expect(fmtPressure(1018.4, metric)).toBe("1018 hPa");
    expect(fmtVisibility(24100, imperial)).toBe("10+ mi");
    expect(fmtVisibility(24100, metric)).toBe("16+ km");
    expect(fmtVisibility(9000, metric)).toBe("9 km");
    expect(fmtVisibility(116000, imperial)).toBe("10+ mi");
    expect(fmtVisibility(3200, imperial)).toBe("2 mi");
    expect(fmtVisibility(800, metric)).toBe("0.8 km");
    expect(fmtVisibility(null, metric)).toBe("–");
  });
  test("UV and air quality", () => {
    expect(uvLabel(1)).toBe("Low");
    expect(uvLabel(4)).toBe("Moderate");
    expect(uvLabel(7)).toBe("High");
    expect(uvLabel(9)).toBe("Very high");
    expect(uvLabel(12)).toBe("Extreme");
    expect(fmtUv(2.34)).toBe("2.3 Low");
    expect(fmtUv(null)).toBe("–");
    for (const [aqi, label] of [[0, "Good"], [50, "Good"], [51, "Moderate"], [100, "Moderate"], [101, "Unhealthy for sensitive groups"], [150, "Unhealthy for sensitive groups"], [151, "Unhealthy"], [201, "Very unhealthy"], [301, "Hazardous"], [999, "Hazardous"]]) {
      expect(aqiCategory(aqi).label).toBe(label);
    }
  });
  test("clocks and days", () => {
    expect(fmtClock("2026-10-28T14:15", true)).toBe("2:15 PM");
    expect(fmtClock("2026-10-28T00:05", true)).toBe("12:05 AM");
    expect(fmtClock("2026-10-28T12:00", true)).toBe("12:00 PM");
    expect(fmtClock("2026-10-28T14:15", false)).toBe("14:15");
    expect(fmtClock("nonsense", true)).toBe("–");
    expect(fmtClock("2026-10-28", true)).toBe("–");
    expect(fmtHour("2026-10-28T15:00", true)).toBe("3 PM");
    expect(fmtHour("2026-10-28T00:00", true)).toBe("12 AM");
    expect(fmtHour("2026-10-28T15:00", false)).toBe("15:00");
    expect(dayName("2026-10-28")).toBe("Wed");
    expect(dayName("2026-11-01")).toBe("Sun");
    expect(dayName("x")).toBe("");
  });
  test("the current hour in the hourly list and range positions", () => {
    const hourly = ["2026-10-28T13:00", "2026-10-28T14:00", "2026-10-28T15:00"].map((time) => ({ time }));
    expect(currentHourIndex(hourly, "2026-10-28T14:15")).toBe(1);
    expect(currentHourIndex(hourly, "2026-10-28T12:00")).toBe(0);
    expect(currentHourIndex(hourly, "2026-10-29T00:00")).toBe(2);
    expect(currentHourIndex([], "x")).toBe(0);
    expect(percentOf(5, 0, 10)).toBe(50);
    expect(percentOf(-5, 0, 10)).toBe(0);
    expect(percentOf(50, 0, 10)).toBe(100);
    expect(percentOf(5, 5, 5)).toBe(50);
  });
});

describe("Open-Meteo requests and replies", () => {
  test("geocoding url", () => {
    const url = new URL(geocodeUrl("https://geocoding-api.open-meteo.com/", "Paris", 10));
    expect(url.origin + url.pathname).toBe("https://geocoding-api.open-meteo.com/v1/search");
    expect(url.searchParams.get("name")).toBe("Paris");
    expect(url.searchParams.get("count")).toBe("10");
    expect(url.searchParams.get("language")).toBe("en");
    expect(new URL(geocodeUrl("http://x", "a".repeat(200), 999)).searchParams.get("count")).toBe("30");
    expect(new URL(geocodeUrl("http://x", "a".repeat(200), 1)).searchParams.get("name").length).toBe(60);
  });
  test("forecast url carries the units and timezone=auto", () => {
    const imperial = new URL(forecastUrl("https://api.open-meteo.com", 48.85, 2.35, "imperial")).searchParams;
    expect(imperial.get("temperature_unit")).toBe("fahrenheit");
    expect(imperial.get("wind_speed_unit")).toBe("mph");
    expect(imperial.get("precipitation_unit")).toBe("inch");
    expect(imperial.get("timezone")).toBe("auto");
    expect(imperial.get("forecast_days")).toBe("7");
    expect(imperial.get("latitude")).toBe("48.85");
    expect(imperial.get("current")).toContain("weather_code");
    expect(imperial.get("hourly")).toContain("precipitation_probability");
    expect(imperial.get("daily")).toContain("sunrise");
    const metric = new URL(forecastUrl("https://api.open-meteo.com", 1, 2, "metric")).searchParams;
    expect([metric.get("temperature_unit"), metric.get("wind_speed_unit"), metric.get("precipitation_unit")]).toEqual(["celsius", "kmh", "mm"]);
    const air = new URL(airUrl("https://air-quality-api.open-meteo.com", 1, 2));
    expect(air.pathname).toBe("/v1/air-quality");
    expect(air.searchParams.get("current")).toContain("us_aqi");
  });
  test("a geocoding reply, with and without results", () => {
    const list = parseGeocode(JSON.stringify({ results: GEO.paris }));
    expect(list).toHaveLength(7);
    expect(list[1]).toMatchObject({ name: "Paris", admin1: "Texas", countryCode: "US", population: 24912 });
    expect(parseGeocode(JSON.stringify({ generationtime_ms: 0.1 }))).toEqual([]);
    for (const bad of ["", "x", "5", "null"]) expect(parseGeocode(bad)).toBeNull();
    const dirty = parseGeocode(JSON.stringify({ results: [null, 5, { name: "A", latitude: 999, longitude: 0 }, { name: "<b>X</b>", latitude: "10.5", longitude: "20", population: "x" }, { name: "", latitude: 1, longitude: 1 }] }));
    expect(dirty).toHaveLength(1);
    expect(dirty[0]).toMatchObject({ name: "<b>X</b>", lat: 10.5, lon: 20, population: 0 });
  });
  test("a forecast reply", () => {
    const f = parseForecast(JSON.stringify(buildForecast({ system: "metric" })));
    expect(f.timezone).toBe("Europe/Paris");
    expect(f.current).toMatchObject({ temp: 15.2, feels: 13.9, humidity: 71, isDay: true, code: 2, pressure: 1018.4, windDir: 225, visibility: 24100 });
    expect(f.hourly).toHaveLength(168);
    expect(f.daily).toHaveLength(7);
    expect(f.daily[0]).toMatchObject({ date: "2026-10-28", code: 2, max: 16, min: 8, pop: 10 });
    expect(f.daily[0].sunrise).toBe("2026-10-28T07:12");
  });
  test("an unusable forecast is null and odd values are dropped", () => {
    for (const bad of ["", "x", "{}", "[]", '{"error":true,"reason":"x"}', '{"current":{}}', '{"current":{"time":"t","temperature_2m":"abc"},"daily":{}}', JSON.stringify({ current: { time: "2026-10-28T14:00", temperature_2m: 5 }, daily: { time: [] } })]) {
      expect(parseForecast(bad), bad).toBeNull();
    }
    const odd = JSON.parse(JSON.stringify(buildForecast({})));
    odd.current.apparent_temperature = null;
    odd.current.visibility = "far";
    odd.hourly.temperature_2m[3] = null;
    odd.daily.temperature_2m_max[2] = null;
    const f = parseForecast(JSON.stringify(odd));
    expect(f.current.feels).toBeNull();
    expect(f.current.visibility).toBeNull();
    expect(f.hourly).toHaveLength(167);
    expect(f.daily).toHaveLength(6);
  });
  test("air quality", () => {
    expect(parseAir(JSON.stringify(buildAir({ aqi: 42.4 })))).toEqual({ aqi: 42, pm25: 8.1, pm10: 14.2 });
    for (const bad of ["", "x", "{}", '{"current":{}}', '{"current":{"us_aqi":-3}}', '{"current":{"us_aqi":"x"}}']) expect(parseAir(bad)).toBeNull();
  });
});

describe("cards", () => {
  const forecast = (system = "imperial") => parseForecast(JSON.stringify(buildForecast({ system })));
  const data = (system = "imperial", air = { aqi: 42 }) => ({ label: "Paris, Île-de-France, France", forecast: forecast(system), air, units: unitsFor(system) });

  test("inline: kicker, now, metrics, hours, days, air quality, attribution", () => {
    const html = buildCard(data(), { layout: "inline" });
    expect(html).toContain("weather-card--inline");
    expect(html).toContain("Weather · Paris, Île-de-France, France");
    expect(html).toContain("Partly cloudy");
    expect(html).toContain("°F");
    expect(html).toContain("Feels like 57°");
    expect(html).toContain("H 61° · L 46°");
    for (const label of ["Wind", "Humidity", "Pressure", "Visibility", "UV index", "Precipitation", "Sunrise", "Sunset"]) expect(html).toContain(`>${label}<`);
    expect(html).toContain("71%");
    expect(html).toContain("7:12 AM");
    expect(html).toContain("5:48 PM");
    expect(html).toContain("Precip. now");
    expect([...html.matchAll(/class="weather-hour"/g)]).toHaveLength(24);
    expect(html).toContain(">Now<");
    expect(html).toContain("Next 24 hours");
    expect([...html.matchAll(/class="weather-day"/g)]).toHaveLength(7);
    expect(html).toContain("7-day forecast");
    expect(html).toContain(">Today<");
    expect(html).toContain(">Thu<");
    expect(html).toContain("weather-aqi-dot--good");
    expect(html).toContain("Air quality (US AQI) · Good");
    expect(html).toContain('<a href="https://open-meteo.com" target="_blank" rel="noopener noreferrer">Open-Meteo.com</a>');
    expect(html).toContain("Weather data by");
    expect(html).toContain("CC BY 4.0");
    expect(html).toContain("Updated 2:15 PM");
  });

  test("metric units", () => {
    const html = buildCard(data("metric"), { layout: "inline" });
    expect(html).toContain("°C");
    expect(html).toContain("14 km/h SW");
    expect(html).toContain("1018 hPa");
    expect(html).toContain("16+ km");
    expect(html).toContain("Updated 14:15");
    expect(html).toContain(">15:00<");
    expect(html).not.toContain("inHg");
  });

  test("the hourly strip starts at the current hour", () => {
    const html = buildCard(data(), { layout: "inline" });
    const strip = html.split('class="weather-hours"')[1];
    expect(strip.indexOf(">Now<")).toBeLessThan(strip.indexOf(">3 PM<"));
    expect(strip).not.toContain(">2 PM<");
  });

  test("without air quality there is no row", () => {
    expect(buildCard(data("imperial", null), { layout: "inline" })).not.toContain("weather-aqi");
  });

  test("panel: compact, 5 days, no hours or metrics", () => {
    const inline = buildCard(data(), { layout: "inline" });
    const panel = buildCard(data(), { layout: "panel" });
    expect(panel).toContain("weather-card--panel");
    expect([...panel.matchAll(/class="weather-mini"/g)]).toHaveLength(5);
    expect(panel).toContain("H 61° · L 46° · Feels like 57°");
    expect(panel).not.toContain("weather-hour");
    expect(panel).not.toContain("weather-grid");
    expect(panel).not.toContain("weather-aqi");
    expect(panel).toContain("Open-Meteo.com");
    expect(panel.length).toBeLessThan(inline.length);
  });

  test("the hint card", () => {
    const html = buildHint();
    expect(html).toContain("Set a home location in the Weather plugin settings");
    expect(html).toContain("weather-card--hint");
  });

  test("everything is escaped and there are no inline styles or handlers", () => {
    const hostile = data();
    hostile.label = '<img src=x onerror="alert(1)">, "><script>';
    const html = buildCard(hostile, { layout: "inline" }) + buildCard(hostile, { layout: "panel" });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain('onerror="');
    expect(html).toContain("&lt;img");
    expect(html).not.toMatch(/<[^>]*\sstyle=/);
    expect(html).not.toMatch(/<[^>]*\son[a-z]+=/i);
    for (const href of [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])) expect(href).toMatch(/^https:\/\/(open-meteo\.com|creativecommons\.org)/);
  });
});

describe("the slot", () => {
  const ctx = (w) => ({ fetch: w.fetch });
  const run = async (query, settings = {}, overrides = {}) => {
    const w = world(overrides);
    const slot = makeSlot(settings);
    const result = await slot.execute(query, ctx(w));
    return { w, slot, result, html: result.html };
  };

  test("a place: geocoding, forecast and air quality, once each", async () => {
    const { w, html, result } = await run("weather in paris texas");
    expect([w.count("geo"), w.count("forecast"), w.count("air")]).toEqual([1, 1, 1]);
    expect(w.calls[0].params.get("name")).toBe("paris");
    expect(w.calls[0].params.get("count")).toBe("20");
    expect(result.title).toBe("");
    expect(html.startsWith('<div class="command-result weather-result">')).toBe(true);
    expect(html).toContain("Weather · Paris, Texas, United States");
    const forecastCall = w.calls.find((c) => c.path === "/v1/forecast");
    expect(forecastCall.params.get("latitude")).toBe("33.6609");
    expect(forecastCall.params.get("longitude")).toBe("-95.5555");
    expect(w.calls[0].headers["User-Agent"]).toBe(USER_AGENT);
    expect(Object.keys(w.calls[0].headers).sort()).toEqual(["Accept", "User-Agent"]);
  });

  test("the place is remembered and the forecast cached for 10 minutes", async () => {
    const time = clock();
    const w = world();
    const slot = makeSlot({}, { time });
    await slot.execute("weather in seattle", ctx(w));
    await slot.execute("seattle weather", ctx(w));
    await slot.execute("forecast seattle", ctx(w));
    await slot.execute("will it rain in seattle", ctx(w));
    expect([w.count("geo"), w.count("forecast"), w.count("air")]).toEqual([1, 1, 1]);
    time.state.t += 9 * 60_000;
    await slot.execute("weather in seattle", ctx(w));
    expect(w.count("forecast")).toBe(1);
    time.state.t += 2 * 60_000;
    await slot.execute("weather in seattle", ctx(w));
    expect([w.count("geo"), w.count("forecast")]).toEqual([1, 2]);
    time.state.t += 31 * 86_400_000;
    await slot.execute("weather in seattle", ctx(w));
    expect(w.count("geo")).toBe(2);
  });

  test("concurrent identical queries share their requests", async () => {
    const w = world({ forecast: async () => { await new Promise((r) => setTimeout(r, 30)); return null; } });
    const slot = makeSlot();
    await Promise.all([slot.execute("weather in seattle", ctx(w)), slot.execute("seattle weather", ctx(w)), slot.execute("weather seattle", ctx(w))]);
    expect([w.count("geo"), w.count("forecast"), w.count("air")]).toEqual([1, 1, 1]);
  });

  test("units decide the forecast request and the card", async () => {
    const imperial = await run("weather in seattle", { units: "imperial" });
    expect(imperial.w.calls.find((c) => c.path === "/v1/forecast").params.get("temperature_unit")).toBe("fahrenheit");
    expect(imperial.html).toContain("°F");
    const metric = await run("weather in seattle", { units: "metric" });
    const call = metric.w.calls.find((c) => c.path === "/v1/forecast");
    expect(call.params.get("temperature_unit")).toBe("celsius");
    expect(call.params.get("wind_speed_unit")).toBe("kmh");
    expect(metric.html).toContain("°C");
    // the cache key includes the units
    const w = world();
    const slot = makeSlot({ units: "imperial" });
    await slot.execute("weather in seattle", ctx(w));
    slot.configure({ units: "metric" });
    await slot.execute("weather in seattle", ctx(w));
    expect(w.count("forecast")).toBe(2);
  });

  test("air quality: inline only, and only when enabled", async () => {
    expect((await run("weather in seattle", { layout: "panel" })).w.count("air")).toBe(0);
    expect((await run("weather in seattle", { showAirQuality: "false" })).w.count("air")).toBe(0);
    let failing;
    await capture(async () => {
      failing = await run("weather in seattle", {}, { air: () => new Response("", { status: 500 }) });
    });
    expect(failing.html).toContain("weather-card--inline");
    expect(failing.html).not.toContain("weather-aqi");
  });

  test("the home location serves a bare weather query, 'near me' and place-less questions", async () => {
    const w = world();
    const slot = makeSlot({ homeLocation: "Charlotte, NC" });
    for (const query of ["weather", "forecast", "weather near me", "is it raining", "how cold is it"]) {
      const html = (await slot.execute(query, ctx(w))).html;
      expect(html, query).toContain("Weather · Charlotte, North Carolina, United States");
    }
    expect(w.count("geo")).toBe(1);
    expect(w.calls[0].params.get("name")).toBe("Charlotte");
  });

  test("no home location: a hint for the bare forms, nothing for questions", async () => {
    const w = world();
    const slot = makeSlot();
    expect((await slot.execute("weather", ctx(w))).html).toContain("Set a home location in the Weather plugin settings");
    expect((await slot.execute("forecast", ctx(w))).html).toContain("Set a home location");
    expect((await slot.execute("weather near me", ctx(w))).html).toContain("Set a home location");
    expect(await slot.execute("is it raining", ctx(w))).toEqual({ title: "", html: "" });
    expect(w.calls).toHaveLength(0);
  });

  test("an unknown place gives no card, and the miss is remembered", async () => {
    const w = world();
    const slot = makeSlot();
    expect(await slot.execute("weather in zzzz", ctx(w))).toEqual({ title: "", html: "" });
    expect(await slot.execute("zzzz weather", ctx(w))).toEqual({ title: "", html: "" });
    expect(w.count("geo")).toBe(1);
    expect(w.count("forecast")).toBe(0);
    expect(await slot.execute("weather in paris kansas", ctx(w))).toEqual({ title: "", html: "" });
    expect(w.count("forecast")).toBe(0);
  });

  test("429 pauses the service for Retry-After with one warning; 5xx for a minute; neither makes a card", async () => {
    const time = clock();
    const w = world({ forecast: () => new Response("", { status: 429, headers: { "retry-after": "180" } }) });
    const slot = makeSlot({}, { time });
    const lines = await capture(async () => {
      expect(await slot.execute("weather in seattle", ctx(w))).toEqual({ title: "", html: "" });
      expect(await slot.execute("weather in oslo", ctx(w))).toEqual({ title: "", html: "" });
    });
    expect(w.count("forecast")).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("paused for 3 min");
    expect(lines[0]).not.toContain("http");
    time.state.t += 181_000;
    expect((await slot.execute("weather in seattle", ctx(world()))).html).toContain("weather-card");

    const boom = world({ geo: () => new Response("", { status: 503 }) });
    const slot2 = makeSlot({}, { time });
    const lines2 = await capture(async () => {
      await slot2.execute("weather in seattle", ctx(boom));
      await slot2.execute("weather in oslo", ctx(boom));
    });
    expect(boom.count("geo")).toBe(1);
    expect(lines2[0]).toContain("paused for 1 min");
  });

  test("an unreadable forecast and a network error give no card and pause", async () => {
    const slot = makeSlot();
    await capture(async () => {
      expect(await slot.execute("weather in seattle", ctx(world({ forecast: () => new Response('{"latitude":1}') })))).toEqual({ title: "", html: "" });
    });
    expect(slot.forecastUpstream.paused).toBe(true);
    const slot2 = makeSlot();
    const lines = await capture(async () => {
      expect(await slot2.execute("weather in seattle", { fetch: async () => { throw new Error("boom https://secret.example"); } })).toEqual({ title: "", html: "" });
    });
    expect(lines.join("")).not.toContain("secret");
  });

  test("the daily budget is shared by the three services", async () => {
    const w = world();
    const slot = makeSlot({ dailyRequestLimit: "2", showAirQuality: "false" });
    await capture(async () => {
      await slot.execute("weather in seattle", ctx(w));
      expect(await slot.execute("weather in oslo", ctx(w))).toEqual({ title: "", html: "" });
    });
    expect(w.calls).toHaveLength(2);
    expect(slot.budget.used).toBe(2);
    expect(makeSlot({ dailyRequestLimit: "0" }).budget.cap).toBe(0);
  });

  test("layouts: position, size and content differ; the card moves with the setting", async () => {
    const inline = makeSlot({ layout: "inline" });
    const panel = makeSlot({ layout: "panel" });
    expect(inline.position).toBe(INLINE_POSITION);
    expect(panel.position).toBe(PANEL_POSITION);
    expect(inline.slotPositions).toBeUndefined();
    const w = world();
    const a = (await inline.execute("weather in seattle", ctx(w))).html;
    const b = (await panel.execute("weather in seattle", ctx(w))).html;
    expect(a).toContain("weather-card--inline");
    expect(b).toContain("weather-card--panel");
    expect(a.length).toBeGreaterThan(b.length);
    inline.configure({ layout: "panel" });
    expect(inline.position).toBe(PANEL_POSITION);
  });

  test("a place name with markup cannot reach the html", async () => {
    const bad = [{ name: '<img src=x onerror="alert(1)">', latitude: 1, longitude: 2, country: "X<b>", admin1: "", country_code: "XX", population: 5, feature_code: "PPL" }];
    const { html } = await run("weather in oops", {}, { geo: () => new Response(JSON.stringify({ results: bad })) });
    expect(html).toContain("weather-card");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
  });

  test("a lookup that is too slow for the slot gives up; the replies are cached for the next search", async () => {
    const gate = Promise.withResolvers();
    const w = world({ forecast: async () => { await gate.promise; return null; } });
    const slot = makeSlot();
    slot.answerWindowMs = 100;
    expect(await slot.execute("weather in seattle", ctx(w))).toEqual({ title: "", html: "" });
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
    slot.answerWindowMs = 5000;
    expect((await slot.execute("weather in seattle", ctx(w))).html).toContain("weather-card");
    expect(w.count("forecast")).toBe(1);
  });

  test("no request is started after 70 % of the slot time", async () => {
    const w = world();
    const slot = makeSlot();
    slot.startWindowMs = -1;
    expect(await slot.execute("weather in seattle", ctx(w))).toEqual({ title: "", html: "" });
    expect(w.calls).toHaveLength(0);
  });

  test("not a weather question: no request; never throws", async () => {
    const w = world();
    const slot = makeSlot();
    expect(await slot.execute("seattle", ctx(w))).toEqual({ title: "", html: "" });
    expect(w.calls).toHaveLength(0);
    await capture(async () => {
      for (const query of [null, undefined, "", "weather in seattle"]) {
        expect(await slot.execute(query, { fetch: async () => { throw new Error("x"); } })).toBeDefined();
        expect(await slot.execute(query, undefined)).toBeDefined();
      }
    });
  });
});

describe("settings", () => {
  test("clamping and defaults", () => {
    expect(layoutFrom("PANEL")).toBe("panel");
    expect(layoutFrom(undefined)).toBe("inline");
    expect(unitsFrom("Metric")).toBe("metric");
    expect(unitsFrom("x")).toBe("imperial");
    expect(unitsFrom(undefined)).toBe("imperial");
    expect(homeFrom("  Charlotte,\n NC  ")).toBe("Charlotte, NC");
    expect(homeFrom("x".repeat(200)).length).toBe(80);
    expect(homeFrom(null)).toBe("");
    const slot = makeSlot({ dailyRequestLimit: "9" });
    expect(slot.budget.cap).toBe(9);
    slot.configure({ dailyRequestLimit: "x" });
    expect(slot.budget.cap).toBe(5000);
  });
  test("the schema", () => {
    expect(SETTINGS_SCHEMA.map((f) => f.key)).toEqual(["layout", "units", "homeLocation", "showAirQuality", "dailyRequestLimit", "debugMatching"]);
    expect(SETTINGS_SCHEMA.find((f) => f.key === "layout")).toMatchObject({ default: "inline", options: ["inline", "panel"] });
    expect(SETTINGS_SCHEMA.find((f) => f.key === "units")).toMatchObject({ default: "imperial", options: ["imperial", "metric"] });
    expect(SETTINGS_SCHEMA.find((f) => f.key === "homeLocation").default).toBe("");
    expect(SETTINGS_SCHEMA.find((f) => f.key === "dailyRequestLimit")).toMatchObject({ default: "5000", advanced: true });
    expect(SETTINGS_SCHEMA.find((f) => f.key === "debugMatching")).toMatchObject({ default: "false", advanced: true });
    expect(SETTINGS_SCHEMA.some((f) => f.required)).toBe(false);
  });
  test("the usage count is per UTC day", () => {
    const budget = new Budget({ file: "", cap: 1, now: () => Date.parse("2026-10-28T10:00:00Z") });
    expect(budget.spend()).toBe(true);
    expect(budget.spend()).toBe(false);
  });
});

describe("debugMatching", () => {
  test("off by default: nothing is logged", async () => {
    const slot = makeSlot();
    const w = world();
    const lines = await capture(async () => {
      slot.trigger("weather app");
      await slot.execute("weather in paris texas", { fetch: w.fetch });
    });
    expect(lines).toEqual([]);
  });
  test("on: a block with the candidates and the choice, and the rule for near misses", async () => {
    const slot = makeSlot({ debugMatching: "true" });
    const w = world();
    const near = await capture(async () => {
      expect(slot.trigger("weather app")).toBe(false);
      expect(slot.trigger("hello world")).toBe(false);
    });
    expect(near).toHaveLength(1);
    expect(near[0]).toContain('"app" is not part of a place name');
    const lines = await capture(async () => {
      await slot.execute("weather in paris texas", { fetch: w.fetch });
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('geocoding: found (request): exact name matches, filtered by "texas"');
    expect(lines[0]).toContain("chosen: Paris, Texas, United States");
    expect(lines[0]).toContain("filtered out: Paris, Île-de-France, France");
    expect(lines[0]).toContain("verdict: card shown");
    expect(lines[0]).not.toContain("http");
  });
});

describe("the bang command", () => {
  test("renders the same card", async () => {
    sharedSlot.spacingMs = 0;
    sharedSlot.budget.file = "";
    const w = world();
    const result = await command.execute("seattle", { fetch: w.fetch });
    expect(result.html).toContain("weather-card");
    expect(command.trigger).toBe("weather");
    expect((await command.execute(["oslo"], { fetch: w.fetch })).html).toBeDefined();
    expect((await command.execute("zzzz", { fetch: w.fetch })).html).toContain("!weather");
  });
});
