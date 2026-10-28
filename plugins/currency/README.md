# Currency converter for degoog

A currency conversion card: fiat rates from [open.er-api.com](https://www.exchangerate-api.com) (one cached request a day) and crypto
prices from Coinbase's public API (no key either). There is no official currency plugin, so nothing needs to be disabled.

| You type | You get |
|---|---|
| `100 usd to eur`, `convert 50 gbp to yen`, `100 dollars in euros`, `how much is 20 euros in dollars` | the conversion, both rates, the amount in your other currencies |
| `usd to eur`, `eur/usd`, `usd to eur exchange rate` | the rate for 1 unit |
| `20 eur`, `$100`, `£20`, `100 yen`, `5 bucks` | the amount in your home currency |
| `1 btc to usd`, `eth to eur`, `100 usd to btc`, `bitcoin price`, `price of ethereum`, `btc` | the crypto price, 24 h change, 24 h low/high, volume |
| `canadian dollars`, `pounds sterling`, `swiss francs`, `reais`, `rupees`, `kronor`, `renminbi`... | names, plurals and symbols (`€ £ ¥ ₹ ₩ ₽ ₺ ₪ ₿`) are understood |

All 166 codes the rates service serves are known. A plain `dollar` or `$` means US dollars unless you change the setting
(`canadian dollars`, `us$`, `a$` are always exact). Some names are ambiguous and use a default: `peso` is the Mexican peso,
`krone` the Danish one, `lira` the Turkish one, `rupee` the Indian one, `riyal` the Saudi one, `¥` the yen. Write the full
name (`philippine pesos`, `norwegian krone`) for the others.

## Setup
1. In degoog: Settings > Store > add this repository, then install **Currency converter** (plugin, plus a command for `!convert`).
2. Nothing else is needed: no key, no account.

## Layout: inline or panel
Setting **Layout**; the card moves as soon as you save.
- **Inline** (default): the detailed card **above the results**: kicker, `100 USD =`, a large result, both rates, a grid of the same
  amount in your secondary currencies, a **Swap** link (a normal link to the reversed search), the date of the rates in the server's
  time zone, and the attribution. Crypto adds price, 24 h change (arrow and colour), 24 h range bar, volume, "Prices from Coinbase".
- **Panel**: the compact card in the **side column**: conversion, one rate line, a tiny attribution.

Inline sits in *above results* rather than *at a glance* because degoog only fills the at-a-glance box when the search returned
results (see the [calculator README](../calculator/README.md)).

## Settings
| Setting | Default |
|---|---|
| Layout | inline |
| Decimals in the converted amount: automatic, or 2 to 8 | automatic (2 for normal amounts, more for small ones and crypto) |
| Home currency (a lone `20 eur` is converted into it) | USD |
| Also show these currencies (comma separated ISO codes, up to 8, five are shown) | EUR, GBP, JPY, CAD, AUD |
| A plain `dollar` or `$` means | US dollar |
| Crypto currencies (Coinbase) | on |
| Exchange rate daily request limit (advanced, 0 = off) | 24 |
| Explain matching in the log (advanced) | off |

## Where the numbers come from
**Fiat**: `GET https://open.er-api.com/v6/latest/USD`, **only the USD base**, once. All cross rates (EUR to GBP, a crypto price in
JPY...) are computed locally. The reply has 166 rates and updates about once a day. The plugin follows the provider's
[free-tier terms](https://www.exchangerate-api.com/docs/free): it caches the rates for 6 hours in memory, in degoog's cache and in
`data/currency/rates.json` (a restart does not fetch again), and fetches again only when the data is older than 6 hours **and** the
provider's next update time has passed. If a refresh fails, rates up to 7 days old are still shown and the card says
"Rates from <date> (could not refresh)". A `429` pauses the source for the `Retry-After` time (20 minutes by default, the block the
provider applies, one hour at most). The daily limit is kept in `data/currency/usage.json`. Attribution is required and is on every
card: "Rates By Exchange Rate API" linking to exchangerate-api.com. Do not redistribute the rates.

**Crypto**: Coinbase's public, keyless endpoints, one upstream each (their own pause and spacing):
`api.coinbase.com/v2/prices/<COIN>-USD/spot` (cached 30 s), `api.exchange.coinbase.com/products/<COIN>-USD/stats` (24 h open, high,
low, last, volume; cached 5 minutes; a coin without a USD product just shows no statistics), `api.coinbase.com/v2/currencies/crypto`
(the list of coins, cached 24 h; fetched the first time a crypto query runs, so rarer coins such as `5 link to usd` work after that;
`btc`, `eth`, `doge`, `xrp`, `ltc` and a few dozen major coins always work). A coin price in another currency goes through USD and
the fiat rates. Only the coin code is ever sent. If the fiat rates are unavailable a crypto card falls back to USD.

All requests use `User-Agent: degoog-currency/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)`. A 5xx or a network
error pauses that upstream for a minute, a 401/403 for 30 minutes (one short log line each, never an address). No request is started
after 70 % of `DEGOOG_SLOT_TIMEOUT_MS` (default 10 s) and a lookup still running at 95 % is given up; its reply is cached for the next search.

## Which queries it takes (and which it never does)
- Pure math (`2+2`, `15% of 80`) and non-currency units (`5 km to miles`) are never taken: they belong to the
  [calculator](../calculator/README.md).
- English words that are also currency codes or names (`try`, `all`, `mad`, `pen`, `top`, `won`, `real`, `pound`, `lei`...) only count in
  an unambiguous form: a **number before them and `to`/`in`/`into`** (`100 try to usd`, `20 pounds to usd`) or a **`convert ...`**
  query. `20 pounds`, `try to usd` or `all` alone do nothing.
- A lone currency is not a conversion (`usd`, `euro`, `dollar`), except `btc`, `eth`, `xrp`, `doge`, `ltc` and the names
  bitcoin/ethereum... which show the price. `bitcoin news` or `euro 2024` are left alone.
- Crypto off (the setting) means no crypto query is taken.

## Bang command
`!convert 100 usd to eur` (aliases `!currency`, `!cur`) renders the same card. Named exports only (`slot`, `command`), see the
calculator README.

## Troubleshooting: why did (or didn't) a card show
Turn on **Explain matching in the log**. A query that mentions a currency but is not a conversion writes one line with the rule
(`"20 pounds" not a conversion: "pounds" is also an ordinary word...`), and every conversion writes a block: amount, from, to, the
rule, whether the rates were fresh or stale, which crypto prices were found, and the verdict. Only the query text is logged.
`bun ./tests/diagnose-currency.js "1 btc to eur"` runs one real lookup in your terminal and prints the replies' status, size and
JSON keys (never values), which is what to paste if a provider changes its layout.

## Development notes
`currencies.js` (codes, names, symbols), `match.js` (grammar), `convert.js` (rates and number formatting), `rates.js` (fiat cache),
`coinbase.js`, `upstream.js` (pause, spacing, budget), `budget.js`, `render.js`, `index.js`. Tests: `tests/currency.test.js`,
`tests/mock-currency-server.js` (one port serving er-api and Coinbase paths; set `DEGOOG_CURRENCY_ER_BASE`,
`DEGOOG_CURRENCY_COINBASE_BASE` and `DEGOOG_CURRENCY_EXCHANGE_BASE` to its address; `GET /__mode?er=429` etc. switches behaviour).
Fixtures are hand-written with invented numbers in the providers' documented layouts.
