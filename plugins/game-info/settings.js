export const SETTINGS_SCHEMA = [
  {
    key: "clientId",
    label: "Twitch client ID",
    type: "text",
    placeholder: "From dev.twitch.tv/console",
    description:
      "IGDB is run by Twitch, so it needs a free Twitch developer app. Go to https://dev.twitch.tv/console and register an application (your Twitch account needs two-factor authentication): any name, OAuth redirect URL http://localhost, category Other, client type Confidential. Then copy the Client ID here. IGDB_CLIENT_ID in the container environment is used when this is empty.",
  },
  {
    key: "clientSecret",
    label: "Twitch client secret",
    type: "password",
    secret: true,
    placeholder: "Press New Secret on the app page",
    description:
      "On the same application page press New Secret and paste it here. Saved on the server only, never shown in a page or written to a log. IGDB_CLIENT_SECRET in the container environment is used when this is empty.",
  },
  {
    key: "requireGameWord",
    label: "Only for queries that sound like games",
    type: "toggle",
    default: "false",
    description:
      "Off: any short query is checked against IGDB and the panel appears only for a confident title match (for example 'skyrim'). On: the query must also contain a game word (game, steam, ps5, xbox, walkthrough...). On costs fewer requests.",
  },
  {
    key: "showProtonDb",
    label: "Show ProtonDB compatibility",
    type: "toggle",
    default: "true",
    description:
      "Adds the Linux / Steam Deck compatibility tier from ProtonDB (one extra request per new game with a Steam page, cached for a day). ProtonDB has no official API, so this may stop working one day. Off makes no ProtonDB requests at all.",
  },
  {
    key: "steamFallback",
    label: "Look up the Steam page when IGDB has none",
    type: "toggle",
    default: "true",
    description:
      "When IGDB does not list a Steam page for a PC game, search the Steam store for a game with exactly the same name (one request, cached for a week). Off makes no Steam requests; the Steam link then only appears when IGDB knows it.",
  },
  {
    key: "showDescription",
    label: "Show a short description",
    type: "toggle",
    default: "true",
    description: "Shows the first few sentences of IGDB's summary under the title.",
  },
  {
    key: "preferBoardGames",
    fieldset: "Display",
    label: "Prefer the board game panel",
    type: "toggle",
    default: "true",
    description:
      "When a board game with the same title matches, show the board game panel and hide this one. Needs the Board games plugin; without it nothing changes. Queries with a video game word (ps5, steam, walkthrough...) always show this panel, and queries with a board game word (board game, rules, tabletop...) never do.",
  },
  {
    key: "boardGameWaitSeconds",
    fieldset: "Display",
    advanced: true,
    label: "How long to wait for the board game answer (seconds)",
    type: "number",
    default: "5",
    placeholder: "5",
    visibleWhen: { key: "preferBoardGames", equals: "true" },
    description:
      "When a video game matches, this plugin asks the Board games plugin whether a board game with the same title matches, and waits at most this long (1 to 8 seconds, and never past 70 % of degoog's slot time). On a slow answer the video game shows and the board game appears from the cache on the next search. A cold answer from the BGG API or recommend.games takes about 1 to 5 seconds.",
  },
  {
    key: "debugMatching",
    fieldset: "Troubleshooting",
    advanced: true,
    label: "Explain matching in the log",
    type: "toggle",
    default: "false",
    description:
      "On: every lookup writes one block to the server log that shows the candidates IGDB returned, how well each name fits, the rating counts, and why the panel showed or not. Rejected title-like queries get one line saying which rule rejected them. Only the query text and game names are logged, never the credentials. Off by default.",
  },
];
