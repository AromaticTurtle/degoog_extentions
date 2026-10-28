# Weather for degoog

A weather card for `weather in Paris`, `forecast`, `is it raining in Seattle`: current conditions, the next 24 hours, a 7-day
forecast and air quality, from [Open-Meteo](https://open-meteo.com). **No key, no account.** It is a replacement for the official
**weather** plugin: **disable the official weather plugin** in Settings > Plugins so the two do not both answer.

| You type | You get |
|---|---|
| `weather in paris`, `paris weather`, `weather paris`, `forecast for paris`, `paris forecast`, `7 day forecast paris` | the card for Paris, France |
| `paris texas weather`, `portland maine weather`, `springfield il weather`, `london ontario weather`, `charlotte nc weather`, `weather in Paris, TX` | the card for that Paris, Portland, Springfield... |
| `temperature in oslo`, `what's the weather like in oslo`, `how cold is it in oslo`, `will it snow in denver tomorrow`, `is it raining in seattle` | the same card |
| `weather`, `forecast`, `weather today`, `weather near me`, `is it raining` | the card for your **home location** (setting), or a small hint card when it is not set (only for the bare `weather` / `forecast` / `near me` forms) |
| `weather app`, `weather radar`, `weather channel`, `weather station`, `weather the storm`, `space weather`, `bad weather`, `sales forecast`, `stock forecast` | nothing: not about the weather at a place |

## Setup
1. In degoog: Settings > Store > add this repository, then install **Weather** (plugin, plus a command for `!weather`).
2. Disable the official **weather** plugin.
3. Optional: Settings > Plugins > Weather > Configure: set **Home location** (for example `Charlotte, NC`) and **Units**.

## Layout: inline or panel
Setting **Layout**; the card moves as soon as you save, no restart.
- **Inline** (default): the detailed card **above the results**: the place, a large temperature with a day/night icon and the
  condition, feels like, high and low; a grid of wind (speed and direction), humidity, pressure, visibility, UV index, chance of
  precipitation, sunrise and sunset; the US air quality index with its category; a **24-hour strip** (scrolls sideways, no visible
  scrollbar) with the time, icon, temperature and rain chance of each hour; the **7-day list** with icon, rain chance and a
  low-to-high bar; "Updated 2:15 PM" (the place's local time) and the attribution.
- **Panel**: the compact card in the **side column**: temperature, icon and condition, high/low/feels like and a 5-day strip.

Inline sits in *above results* rather than *at a glance* because degoog only fills the at-a-glance box when the search returned
results (see the [calculator README](../calculator/README.md)).

## Settings
| Setting | Default |
|---|---|
| Layout | inline |
| Units: imperial (°F, mph, inHg, miles, inches, 12-hour clock) or metric (°C, km/h, hPa, km, mm, 24-hour clock) | imperial |
| Home location (free text, resolved once and remembered) | empty |
| Show air quality (inline layout only, one extra request) | on |
| Daily request limit (advanced, 0 = off) | 5000 |
| Explain matching in the log (advanced) | off |

Times are always the place's own local time (`timezone=auto`).

## Which place? ("Paris, Texas" vs "Paris, France")
The geocoding service only searches by name, so the place text is split into a **name** and a **hint** (a US state or Canadian
province by name or abbreviation, a country by name or code): `paris texas`, `paris tx`, `Paris, TX`. The name is searched (10
results, 20 when there is a hint), then:
1. with a hint, only results in that state/province/country are kept; with a state or country the plugin knows, a hint that matches
   nothing means **no card** (rather than a wrong city); an unknown two-letter hint that matches nothing is ignored;
2. exact name matches are preferred over the service's fuzzy ones, populated places over regions;
3. the most populated place wins (so plain `paris` is Paris, France, `springfield` is Springfield, Missouri).

The kicker always says what was chosen: `WEATHER · PARIS, TEXAS, UNITED STATES`. Add the state or country to get another one. A place
the service does not know shows nothing (and the miss is remembered for 7 days).

## What it asks, and how gently
Three Open-Meteo services, each with its own pause and spacing, all counted in **one** daily budget (the free non-commercial tier
allows about 10,000 calls a day for all of them together; the default cap is 5,000):
- `geocoding-api.open-meteo.com/v1/search` (cached 30 days),
- `api.open-meteo.com/v1/forecast` with `timezone=auto` and the unit parameters of your setting (cached 10 minutes per place and unit),
- `air-quality-api.open-meteo.com/v1/air-quality` (inline layout only; cached 10 minutes).

A card costs at most three requests; identical concurrent lookups share them. `User-Agent: degoog-weather/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)`.
A `429` pauses that service for `Retry-After` (5 minutes by default, an hour at most), a 5xx or a network error for a minute, each
with one short log line, never an address. No request is started after 70 % of `DEGOOG_SLOT_TIMEOUT_MS` (default 10 s) and a lookup
still running at 95 % is given up; its reply is cached for the next search. Weather alerts are not offered (Open-Meteo has none).

## Attribution and terms
"Weather data by Open-Meteo.com" (linked to https://open-meteo.com) is on every card. Open-Meteo's data is licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) and its free API is for **non-commercial use**; read their
[terms](https://open-meteo.com/en/terms) if your instance is public.

## Bang command
`!weather paris` (aliases `!forecast`, `!wx`) renders the same card; `!weather` alone uses the home location. Named exports only
(`slot`, `command`), see the calculator README.

## Troubleshooting: why did (or didn't) a card show
Turn on **Explain matching in the log**. A near miss (`weather app`) writes one line with the reason; a lookup writes a block:

```
[weather] "weather in paris texas" -> rule: weather <place>, units=imperial, layout=inline
  place text "paris texas"
  geocoding: found (request): exact name matches, filtered by "texas", most populated
    chosen: Paris, Texas, United States (population 24912)
    filtered out: Paris, Île-de-France, France (population 2138551)
  forecast: ok (request); air quality: ok (US AQI 42)
  verdict: card shown
```
`bun ./tests/diagnose-weather.js "weather in paris texas"` runs one real lookup (three requests at most) in your terminal and prints each
reply's status, size and JSON field names.

## Development notes
`match.js` (grammar), `places.js` (name and hint split, ranking), `request.js` (URLs, defensive parsers), `wmo.js` (weather codes and
icons), `format.js` (units, clocks), `render.js`, `upstream.js`, `budget.js`, `index.js`. Tests: `tests/weather.test.js`,
`tests/mock-weather-server.js` (set `DEGOOG_WEATHER_FORECAST_BASE`, `DEGOOG_WEATHER_GEOCODING_BASE` and `DEGOOG_WEATHER_AIR_BASE` to
its address; `GET /__mode?forecast=429` etc. switches behaviour). Fixtures: a hand-written geocoding file and a forecast builder that
uses invented numbers in Open-Meteo's documented layout.
