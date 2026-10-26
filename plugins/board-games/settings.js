export const SETTINGS_SCHEMA = [
  {
    key: "apiToken",
    label: "BGG API token",
    type: "password",
    secret: true,
    placeholder: "Issued after BGG approves your application",
    description:
      "Needed: since late 2025 BoardGameGeek's XML API only answers registered applications. Register one at https://boardgamegeek.com/applications (or through the form linked from https://boardgamegeek.com/using_the_xml_api) and describe it as a personal, non-commercial search page. Approval can take a while; BGG then gives you a token. Paste it here. Saved on the server only and sent only in a request header. BGG_API_TOKEN in the container environment is used when this is empty.",
  },
  {
    key: "requireBoardGameWord",
    label: "Only for queries that sound like board games",
    type: "toggle",
    default: "false",
    description:
      "Off: any short title-like query is checked against BGG and the panel appears only for a confident match (for example 'wingspan'). Queries with video game words (ps5, steam, walkthrough...) are always skipped. On: the query must also contain a board game word (board game, tabletop, rules, meeple, expansion, bgg...). On costs far fewer requests.",
  },
  {
    key: "showDescription",
    label: "Show a short description",
    type: "toggle",
    default: "true",
    description: "Shows the first few sentences of the game's BGG description under the title.",
  },
  {
    key: "dailyRequestLimit",
    label: "Daily request limit",
    type: "number",
    default: "300",
    placeholder: "300",
    description:
      "Stops calling BGG once this many requests were made in a UTC day. BGG publishes no numeric limit, so this is a conservative guard. 0 turns it off. The count is kept in data/bgg/usage.json.",
  },
];
