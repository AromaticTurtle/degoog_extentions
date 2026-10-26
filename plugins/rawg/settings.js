export const SETTINGS_SCHEMA = [
  {
    key: "apiKey",
    label: "RAWG API key",
    type: "password",
    secret: true,
    placeholder: "Free at rawg.io/apidocs",
    description:
      "Needed: RAWG answers nothing without a key. Get a free one at https://rawg.io/apidocs (the free plan is for non-commercial use and allows 20,000 requests a month). Saved on the server only. RAWG_API_KEY in the container environment is used when this is empty.",
  },
  {
    key: "requireGameWord",
    label: "Only for queries that sound like games",
    type: "toggle",
    default: "false",
    description:
      "Off: any short query is checked against RAWG and the panel appears only for a confident title match (for example 'elden ring'). On: the query must also contain a game word (game, steam, ps5, xbox, walkthrough...). On costs fewer requests.",
  },
  {
    key: "showDetails",
    label: "Fetch full details",
    type: "toggle",
    default: "true",
    description:
      "One extra request per new game (then cached for a week) adds the description, developer, publisher and official website. Off shows only what the search result already has.",
  },
  {
    key: "monthlyBudget",
    label: "Monthly request limit",
    type: "number",
    default: "15000",
    placeholder: "15000",
    description:
      "Stops calling RAWG once this many requests were made in a calendar month, so the free 20,000 is never exceeded. 0 turns the guard off. The count is kept in data/rawg/usage.json.",
  },
];
