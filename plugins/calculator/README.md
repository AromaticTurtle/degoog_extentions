# Calculator for degoog

A calculator and unit converter card for degoog. It answers by itself, on your server: **no request is made to anyone**, nothing
you type leaves degoog. It is a replacement for the official **math** plugin: **disable the official math plugin** in
Settings > Plugins so the two do not both answer.

| You type | You get |
|---|---|
| `2+2`, `(1+2)*3`, `2(3+4)`, `2pi`, `7 x 6`, `10 % 3` | the result, with the expression tidied (`2 × (3 + 4)`) |
| `2^100`, `20!`, `100!/98!` | **exact** integers however large (up to 5,000 digits), plus hex, binary, octal and scientific notation |
| `0.1+0.2`, `sin(30 deg)` | `0.3`, `0.5`: float noise is trimmed to the number of digits you choose |
| `15% of 80`, `80 + 15%`, `80 - 15%`, `20% off 45`, `what is 15 percent of 80` | the answer plus a small breakdown (X% of Y, Y + X%, Y - X%) |
| `sqrt(16)`, `log(1000)`, `ln(e)`, `sin(pi/6 rad)`, `max(1,5)`, `round(2.567, 1)`, `mod(17,5)` | the functions below |
| `5 km to miles`, `100 f to c`, `12 cups in ml`, `3 days in hours`, `50 mph to km/h`, `5 gb to mb` | the conversion plus the same quantity in four related units |
| `255 in hex`, `255 to binary`, `0xff in decimal`, `64 as octal` | the number in that base, plus the other bases |
| `what is 24/7`, `calc 24/7`, `= 4*4`, `2+2=` | an explicit prefix or `=` makes even a short fraction a calculation |

Everything else is left alone: plain numbers, years, dates (`2026-10-28`), versions (`3.5.1`), phone numbers, IP addresses,
ranges (`1-2`), sizes (`1920x1080`, `4x4`), product names (`iphone 15 pro`) and ordinary text never trigger it. Use spaces or
an explicit prefix when a calculation looks like one of those (`100 / 4` or `calc 24/7`; a bare `24/7` is a time, not a fraction).

## Setup
1. In degoog: Settings > Store > add this repository, then install **Calculator**. It shows up as one entry, **Calculator**, in Settings > Plugins.
2. Disable the official **math** plugin. Nothing else is needed: there is no key and no upstream.

## Layout: inline or panel
Setting **Layout** (Settings > Plugins > Calculator > Configure). The card moves as soon as you save, no restart.

- **Inline** (default): the detailed card **above the results** in the main column: pretty expression, a large result, chips
  (scientific notation, hex/binary/octal for integers, a fraction when the result is a clean one such as `3/8`), the percentage
  breakdown, the related-units grid, and a **Copy** button.
- **Panel**: the compact card in the **side column**: expression, result and one line of extra information.

Why *above results* and not *at a glance*: degoog's at-a-glance box is only filled when the search returned results (its page code
clears it for an empty result list), and it is built around a search-result snippet. A calculation should not depend on whether
your engines answered. *Above results* shows immediately, uses degoog's own panel (background, radius, shadow), and sits next to the
other slot cards. *Full width above results* has no panel chrome of its own and stretches the card across the whole page.

## Settings
| Setting | Default |
|---|---|
| Layout: inline or panel | inline |
| Group digits with thousands separators (the Copy button always copies the plain number) | on |
| Angle mode for sin, cos, tan...: radians or degrees (`sin(30 deg)` and `sin(pi/6 rad)` always mean what they say) | radians |
| Significant digits, 6 to 15 (integers stay exact) | 12 |
| Explain matching in the log (advanced) | off |

## What the engine understands
- Operators `+ - * / ^ ** %`, `×` `÷` `·` and `x` between numbers, parentheses, implicit multiplication, `n!`, thousands separators
  (`1,234.5`), scientific notation (`1.5e3`), hex/binary/octal literals (`0xff`, `0b101`, `0o17`).
- Constants `pi` (`π`), `e`, `tau`, `phi`. Functions `sqrt cbrt abs round floor ceil ln log log2 exp sin cos tan asin acos atan sinh cosh
  tanh min max pow mod fact`.
- `%` is a percentage next to a number (`15%`, `80 + 15%`) and a remainder between two numbers (`10 % 3`).
- Integers use exact BigInt arithmetic for `+ - *`, `^` with a non-negative integer exponent, `!` and integer division. Caps keep it
  safe: 200 characters, 40 levels of nesting, 5,000 digits, factorial up to 1,000. Division by zero shows **undefined**; a result
  too big or not a real number says so. Bad input never raises an error.
- **No `eval`, no `Function`**: a small tokenizer and parser, and an evaluator over the tree.
- Units (US/imperial where a word is ambiguous: `gallon`, `pint`, `quart`, `cup`, `ton`): length, mass, temperature, volume, speed,
  area, data (`kb` = 1000 bytes, `kib` = 1024; a lowercase `b` is a bit, `B` a byte), time (a month is 30.44 days, a year 365.24),
  pressure and energy. Plurals and spellings (`kilometers`, `kilometres`, `lbs`, `°F`, `degrees fahrenheit`) work.

## Which plugin answers which query
The core plugins (calculator, currency, dictionary) do not fight over queries; each keeps its own copy of its rules and a test
(`tests/core-routing.test.js`) checks them against one table:
- the calculator **never takes currency codes or names**: `100 usd to eur`, `5 dollars to euros`, `1 btc to usd` belong to the
  [currency plugin](../currency/README.md). (`5 pounds to kg` is a mass here; `20 pounds to usd` is money there.)
- the currency plugin never takes pure math or non-currency units;
- the dictionary only answers with an explicit word such as `define`.


## The Copy button
`script.js` (loaded by degoog on every page) listens on the document, because slot html is injected after the page loads. On a plain
http address (a LAN address) browsers do not offer the clipboard API, so it falls back to a temporary text area and
`document.execCommand("copy")`. If the fallback is blocked nothing happens.

## Troubleshooting: why did (or didn't) a card show
Turn on **Explain matching in the log**. Every query that contains a digit then writes one line to the server log, for example:

```
[calculator] "2026-10-28" not a calculation: looks like a date layout=inline
[calculator] "15% of 80" taken as math expression (= 12) layout=inline
```
Only the query text is logged. Off by default (no overhead).

## Development notes
`expr.js` (tokenizer, parser, evaluator), `units.js` (tables), `match.js` (gating, `analyse()`), `format.js` (numbers, radix,
fractions, pretty expression), `render.js` (cards), `index.js` (slot and command), `script.js` (copy button). `bun test`
runs `tests/calculator.test.js` (engine table, a gating table of positives and negatives, units, bases, formatting, layouts,
hostile input) and the cross-plugin routing test.

## Changelog
**Version 1.1.0:** the `!calc` bang command was removed. degoog lists a plugin's slot and its command as two separate entries in Settings > Plugins, and a plugin file cannot be both, so every plugin showed twice. The plain queries above cover everything the bang did. After updating, restart degoog (or reload extensions) so the old `calculator-command` entry disappears; settings you saved on the slot entry are kept.
