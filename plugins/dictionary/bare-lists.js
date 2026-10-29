// Word lists for the bare-word trigger, kept in one file so they can be read, tested and adjusted in one place.

const set = (text) => new Set(text.trim().split(/\s+/));

// Popular sites, brands and navigation words: a bare search for one of these wants the site, not the dictionary, and the lookup
// would only cost a request. Modest on purpose; a word missing here is simply looked up (and a miss is cached for 24 hours).
export const BARE_STOPLIST = set(`
  google youtube facebook instagram twitter reddit amazon gmail outlook hotmail yahoo bing duckduckgo netflix whatsapp tiktok linkedin pinterest
  snapchat tumblr twitch discord telegram skype zoom slack dropbox github gitlab stackoverflow wikipedia wikimedia craigslist ebay etsy walmart
  costco paypal venmo spotify soundcloud hulu roblox minecraft fortnite chatgpt openai mapquest yelp tripadvisor airbnb expedia doordash grubhub
  login logout signin signup webmail inbox homepage webpage website torrent torrents lyrics porn xxx www http https html css javascript
`);

// Words another core plugin answers by itself, by exact casing. The dictionary stays out of the way so two cards never answer one query.
// (Each plugin keeps its own gating; tests/domain-routing.test.js and tests/dictionary.test.js check these lists against the plugins.)
export const DEFER = {
  // plugins/weather: a bare "weather" or "forecast" is the home-location card
  weather: set(`weather forecast forecasts weathers`),
  // plugins/sports: "score" and "scores" are sports words (a team plus a score word is the card), and so are the league names
  sports: set(`score scores nfl nba mlb nhl mls epl wnba ncaa ncaaf ncaab`),
  // plugins/calculator: constants, function names and the words for the calculator itself
  calculator: set(`pi tau phi calc calculator calculate sin cos tan asin acos atan sinh cosh tanh sqrt cbrt log ln exp`),
  // plugins/currency: crypto currencies it answers on their own ("bitcoin", "btc")
  currency: set(`bitcoin btc ethereum ether eth ripple xrp dogecoin doge litecoin ltc`),
  // plugins/stocks: the well-known tickers it answers in lower case ("msft"); capitals are handled by the casing rule
  stocks: set(`aapl msft goog googl amzn tsla meta nvda nflx amd intc ibm dis pep wmt jpm bac pypl uber abnb orcl crm adbe csco qcom avgo txn coin pltr snap pins spot xom cvx pfe mrk jnj unh abbv lly cost tgt nke mcd sbux cmg wfc axp schw blk spy qqq voo vti iwm dia arkk`),
};

// ISO 4217 codes of the currencies the currency plugin knows, minus the ones that are also ordinary English words ("all", "try", "top",
// "pen", "cup", "mad"...). A bare code is not a word to look up, and the currency plugin would not take it alone either.
export const CURRENCY_CODES = set(`
  aed afn amd aoa aud awg azn bam bbd bdt bgn bhd bif bmd bnd brl bsd btn bwp byn bzd cad cdf chf clf clp cnh cny crc cve czk djf dkk dop dzd egp etb
  eur fjd fkp gbp ggp ghs gip gmd gnf gtq gyd hkd hnl hrk htg huf idr ils imp inr iqd irr isk jep jmd jod jpy kes kgs khr kmf krw kwd kyd kzt lbp lkr
  lrd lsl lyd mdl mga mkd mmk mnt mru mvr mwk mxn myr mzn ngn nio nok npr nzd omr pab pgk php pkr pln pyg qar rsd rwf sbd scr sdg sgd shp sle sll srd
  ssp stn syp szl thb tjs tmt ttd tvd twd tzs uah ugx usd uyu uzs ves vnd vuv wst xaf xcd xcg xdr xof xpf yer zar zmw zwg zwl
`);
