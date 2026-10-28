# Stocks for degoog (Finnhub)

A stock quote card for `AAPL stock`, `$AAPL`, `apple stock price` and, if you like, a bare `AAPL`: the price, the day's change, the
market status, the day and 52-week ranges and a few statistics, from [Finnhub](https://finnhub.io)'s free API. **It needs a free
Finnhub API key. Without a key the plugin shows nothing.** The free plan covers **US stocks only**.

| You type | You get |
|---|---|
| `AAPL stock`, `AAPL stock price`, `AAPL share price`, `AAPL quote`, `AAPL shares`, `stock AAPL`, `stock price of AAPL` | the card for AAPL |
| `$AAPL`, `$BRK.B`, `$ALL`, `$NOW` | the card: the dollar sign always means "ticker" |
| `apple stock`, `tesla stock price today`, `coca cola stock`, `stock tesla` | the company is looked up (Finnhub search), then the card |
| `AAPL`, `TSLA`, `msft`, `QFRN` (setting **Show a card for a bare ticker**, on by default) | the card, when the ticker checks out (below) |
| `chicken stock`, `stock pot`, `stock photo`, `stock car`, `stock market`, `out of stock`, `penny stock`, `define stock` | nothing: not about shares |
| `usd`, `eur`, `btc`, `NOW`, `ALL`, `love`, `GO`, `hello` | nothing: currency/crypto codes and common words are not tickers (use `$` to force one) |

## Setup: get a free key
1. Create a free account at <https://finnhub.io/register>.
2. Copy your **API key** from the dashboard: <https://finnhub.io/dashboard>.
3. Put it in **one** of these places (the settings value wins when both are set):
   - **degoog's settings**: Settings > Plugins > Stocks (Finnhub) > Configure > *Finnhub API key*. It is stored on the server only.
   - **the container environment**: `FINNHUB_API_KEY=your-key` (for example `-e FINNHUB_API_KEY=...` or in your compose file).
4. Install the plugin from this repository (Settings > Store), and enable it. It also adds a `!stock aapl` command.

The key is sent **only** in the request header `X-Finnhub-Token`. It is never put in a URL, a log line, an error message, the page, or a
file on disk; a test checks all of that. Finnhub's free plan: **60 calls a minute, US stocks, no card needed**. Candle (chart) data
is premium on some plans, so the sparkline is optional (below).

## Layout: inline or panel
Setting **Layout**; the card moves as soon as you save, no restart.
- **Inline** (default): the detailed card **above the results**: the company logo (loaded through degoog's image proxy, hidden when it
  fails), name, exchange and industry; the price with the currency; the change with an arrow and a sign and the percentage (green up,
  red down, never colour alone); a **market status pill** (Market open / Pre-market / After hours / Market closed, or the holiday)
  and the time of the last trade; a sparkline when candles are available; the **day range** and **52-week range** bars with a marker
  at the current price; open, previous close, market cap (T/B/M), P/E, EPS, dividend yield and beta; the company's website; "Data from Finnhub".
- **Panel**: the compact card in the **side column**: name, price, change, market status and the day range.

Inline sits in *above results* rather than *at a glance* because degoog only fills the at-a-glance box when the search returned
results (see the [calculator README](../calculator/README.md)).

## Settings
| Setting | Default |
|---|---|
| Finnhub API key (password field) | empty (the `FINNHUB_API_KEY` environment variable is used then) |
| Layout | inline |
| Show a price sparkline when available | on |
| Show a card for a bare ticker (AAPL, TSLA, MSFT) | on |
| Daily request limit (advanced, 0 = off) | 2000 |
| Explain matching in the log (advanced) | off |

## When a card shows: bare tickers
Explicit forms (`AAPL stock`, `$AAPL`, `apple stock price`, `stock AAPL`) are always on. A **bare** query is a stock card only when
all of these hold, and the plugin never spends more than **two Finnhub calls** to decide:
- the whole query is **one token of 1 to 5 letters** (optionally a class like `BRK.B`);
- it is **not on the stoplist**: common words that are also tickers or likely searches (`A`, `ALL`, `ARE`, `CAN`, `FOR`, `NOW`, `ON`,
  `ONE`, `IT`, `SO`, `TV`, `HAS`, `WELL`, `SEE`, `GO`, `LOVE`, `FUN`, `REAL`, `TRUE`, `BEST`, `LOW`, `HE`, `CAT`, ...), abbreviations,
  ISO currency codes (`USD`, `EUR`...) and crypto symbols (`BTC`, `ETH`...). The list is `stoplist.js`; `$NOW` bypasses it;
- it is typed in **capitals**, or it is on a small list of **well-known tickers** (`AAPL`, `MSFT`, `GOOG`, `AMZN`, `TSLA`, `META`,
  `NVDA`, `NFLX`, `AMD`, `INTC`, `IBM`, `DIS`, `KO`, `PEP`, `WMT`, `JPM`, `BAC`, `V`, `MA`, `PYPL`, `UBER`, `ABNB`...). One or two letter
  tickers (`V`, `MA`, `KO`) still need capitals;
- Finnhub **confirms** it: for a well-known ticker one `/quote` call must answer a price above zero; for any other, `/search` must
  list that exact symbol as a stock (not a warrant or a right) and `/quote` must then answer a price above zero.

A bare candidate that fails is remembered **on disk for 24 hours** (`data/stocks/cache.json`), so the same non-ticker costs nothing
afterwards, even after a restart. Turn the setting off if you do not want bare tickers at all.

Company names (`apple stock`) go through Finnhub's `/search`: the first common stock, ETF or ADR on a US-style symbol (no `.DE`
suffix, a one-letter class like `BRK.B` is fine), then a positive quote. The answer is remembered for 30 days.

## What a card costs (Finnhub calls)
| Call | Cached |
|---|---|
| `/quote` | 45 seconds while the market is open, 10 minutes when it is closed |
| `/stock/profile2` (name, exchange, logo, market cap, website) | 7 days |
| `/stock/metric?metric=all` (52-week range, P/E, EPS, dividend yield, beta) | 6 hours |
| `/stock/market-status?exchange=US` | 2 minutes |
| `/stock/candle` (sparkline; inline layout only) | 10 minutes |
| `/search` (name or bare ticker to symbol) | 30 days; a miss 24 hours |

So a first card is about 4 to 6 calls and a repeat view within a minute is free. Requests are kept **under 50 a minute** (a client-side
limit; the free plan allows 60) and a daily limit applies (default 2000, kept in `data/stocks/usage.json`).

**Candles.** The plugin asks once. If Finnhub answers **403** (candles are not on your plan) it remembers that for a day, on disk, and
stops asking; the card is complete without the sparkline. Nothing is ever retried in a loop.

**Failures.** `429`: the plugin pauses for `Retry-After` (a minute by default, five at most) with one log line. `401` (key rejected):
paused for 30 minutes, **quietly** (explained by *Explain matching in the log* only). `403` on a quote (a non-US symbol): no card, no pause,
remembered for an hour. 5xx or network: paused for a minute. No request starts after 70 % of `DEGOOG_SLOT_TIMEOUT_MS` (default 10 s);
a lookup still running at 95 % is given up and its replies are cached for the next search.

## Which plugin answers which query
The calculator, currency, dictionary, weather and stocks plugins do not fight over queries (`tests/core-routing.test.js` checks a shared
table): stocks never takes currency or crypto codes without `$`, never takes `stock` in a non-financial sense and never takes pure math;
`define stock` goes to the dictionary, `10 usd to eur` to the currency plugin.

## Bang command
`!stock aapl` or `!stock apple` (aliases `!stocks`, `!quote`) renders the same card. Named exports only (`slot`, `command`), see the
calculator README. A small `script.js` hides a company logo that fails to load.

## Troubleshooting: why did (or didn't) a card show
Turn on **Explain matching in the log**. A near miss writes one line with the rule, a lookup one block, and the key is never in it:

```
[stocks] "QFRN" -> bare rule: uppercase ticker, symbol=QFRN direct=false, layout=inline
  search: QFRN
  quote QFRN: ok (request) [after search]
  profile: ok (request); metric: ok (request); market status: ok (request); candles: skipped (candles are not on this plan (remembered))
  verdict: card shown
[stocks] "NOW" not a stock query: NOW is a common word, an abbreviation or a currency/crypto code (write $NOW to force it)
[stocks] "AAPL stock" looks like a stock query (explicit stock query (<name> stock)) but no lookup: no API key is set (settings or FINNHUB_API_KEY)
```

**Check your own plan** (run it in your terminal so the key never leaves your machine; fish shell):
```fish
read -sx FINNHUB_API_KEY
bun ./tests/diagnose-stocks.js AAPL
set -e FINNHUB_API_KEY
```
It makes at most six requests (quote, profile, search, metric, market status, candles), prints for each whether your plan includes it
and the **names** of the fields it found (never values), and refuses to print anything that contains the key.

## Development notes
`match.js` (grammar), `stoplist.js` (word lists), `finnhub.js` (URLs, defensive parsers, symbol picking), `upstream.js` (rate window,
pauses), `store.js` (the small on-disk memory), `format.js`, `render.js`, `budget.js`, `index.js`, `script.js`. Tests:
`tests/stocks.test.js`, `tests/mock-stocks-server.js` (set `DEGOOG_STOCKS_API_BASE=http://host:4510/api/v1`; it requires the header
`X-Finnhub-Token: test-key` and refuses a key in a URL). The fixtures use invented companies (Quillfern Systems `QFRN`, Brambleton Foods
`BRMB`, Midsummer Optics `MIDS`) in Finnhub's documented layouts.
