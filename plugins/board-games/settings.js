export const SETTINGS_SCHEMA = [
  {
    key: "enableApi",
    fieldset: "Sources",
    label: "Use the BGG XML API",
    type: "toggle",
    default: "true",
    description:
      "Source 1, always tried first. BoardGameGeek's licensed API; it needs a token (below) and is skipped without one. Details are fetched in one batch request.",
  },
  {
    key: "apiToken",
    fieldset: "Sources",
    label: "BGG API token",
    type: "password",
    secret: true,
    placeholder: "Issued after BGG approves your application",
    visibleWhen: { key: "enableApi", equals: "true" },
    description:
      "Since late 2025 BoardGameGeek's XML API only answers registered applications. Register one at https://boardgamegeek.com/applications (or through the form linked from https://boardgamegeek.com/using_the_xml_api) and describe it as a personal, non-commercial search page. Approval can take a while; BGG then gives you a token. Paste it here. Saved on the server only and sent only in a request header. BGG_API_TOKEN in the container environment is used when this is empty.",
  },
  {
    key: "enableRecommendGames",
    fieldset: "Sources",
    label: "Use recommend.games when the first source is unavailable",
    type: "toggle",
    default: "true",
    description:
      "Source 2. recommend.games is a small third-party site that mirrors BoardGameGeek data. No key needed; one request returns everything. It states no data licence or rate limits and could change or disappear.",
  },
  {
    key: "enableBggInternal",
    fieldset: "Sources",
    label: "Use BGG's own website API as a last resort",
    type: "toggle",
    default: "false",
    description:
      "Source 3, off by default. This is the JSON API that BoardGameGeek's own website uses. It needs no key, but BGG's XML API terms describe it as unlicensed, so please decide for yourself whether to use it. It has no name search, so game ids come from Wikidata (only games with a BoardGameGeek id there) or from an earlier source. 2 requests per game, rate limited, and it may break or be blocked at any time.",
  },
  {
    key: "requireBoardGameWord",
    fieldset: "Display",
    label: "Only for queries that sound like board games",
    type: "toggle",
    default: "false",
    description:
      "Off: any short title-like query is checked and the panel appears only for a confident match (for example 'wingspan'). Queries with video game words (ps5, steam, walkthrough...) are always skipped. On: the query must also contain a board game word (board game, tabletop, rules, meeple, expansion, bgg...). On costs far fewer requests.",
  },
  {
    key: "showDescription",
    fieldset: "Display",
    label: "Show a short description",
    type: "toggle",
    default: "true",
    description: "Shows the first few sentences of the game's description under the title.",
  },
  {
    key: "dailyRequestLimit",
    fieldset: "Limits",
    advanced: true,
    label: "BGG API daily request limit",
    type: "number",
    default: "300",
    placeholder: "300",
    visibleWhen: { key: "enableApi", equals: "true" },
    description:
      "Stops calling the BGG XML API once this many requests were made in a UTC day. BGG publishes no numeric limit, so this is a conservative guard. 0 turns it off. The count is kept in data/bgg/usage.json.",
  },
  {
    key: "recommendGamesDailyLimit",
    fieldset: "Limits",
    advanced: true,
    label: "recommend.games daily request limit",
    type: "number",
    default: "500",
    placeholder: "500",
    visibleWhen: { key: "enableRecommendGames", equals: "true" },
    description:
      "Stops calling recommend.games once this many requests were made in a UTC day. It is a small project with no published limits, so be gentle. 0 turns it off. The count is kept in data/bgg/usage-recommend-games.json.",
  },
  {
    key: "internalDailyLimit",
    fieldset: "Limits",
    advanced: true,
    label: "BGG website API daily request limit",
    type: "number",
    default: "100",
    placeholder: "100",
    visibleWhen: { key: "enableBggInternal", equals: "true" },
    description:
      "Stops calling BGG's website API (and Wikidata, which it uses to find ids) once this many requests were made in a UTC day. 0 turns it off. The count is kept in data/bgg/usage-geekdo.json.",
  },
  {
    key: "debugMatching",
    fieldset: "Troubleshooting",
    advanced: true,
    label: "Explain matching in the log",
    type: "toggle",
    default: "false",
    description:
      "On: every lookup writes one block to the server log that shows which source answered, the candidates it returned, how well each title fits, the rating counts, and why the panel showed or not. Rejected title-like queries get one line saying which rule rejected them, and a lookup that is still running when the time is up says so. Only the query text and game names are logged, never the token. Off by default.",
  },
];
