export const SETTINGS_SCHEMA = [
  {
    key: "apiToken",
    fieldset: "Account",
    label: "Hardcover API token",
    type: "password",
    secret: true,
    placeholder: "From Hardcover > Account > Hardcover API",
    description:
      "Needed: Hardcover's API answers nothing without a token. In Hardcover go to your account settings > Hardcover API > New API Key, give it a name, set an expiry, and choose ONLY the read:catalog permission (public catalog data and search). Never choose the 'all' permission: a token with it can modify or delete your account. Paste the token here (with or without a leading 'Bearer '). It is saved on the server only and sent only in a request header. HARDCOVER_API_TOKEN in the container environment is used when this is empty. Tokens expire, and Hardcover may reset tokens during its beta.",
  },
  {
    key: "requireBookWord",
    fieldset: "Display",
    label: "Only for queries that sound like books",
    type: "toggle",
    default: "false",
    description:
      "Off: any short title-like query is checked against Hardcover and the panel appears only for a confident match (for example 'project hail mary'). Queries with video game or board game words (ps5, walkthrough, board game...) are always skipped. On: the query must also contain a book word (book, novel, author, isbn, series, summary, read...) or say 'by <author>'. On costs far fewer requests.",
  },
  {
    key: "showDescription",
    fieldset: "Display",
    label: "Show a short description",
    type: "toggle",
    default: "true",
    description: "Shows the first few sentences of the book's description under the title.",
  },
  {
    key: "dailyRequestLimit",
    fieldset: "Limits",
    advanced: true,
    label: "Daily request limit",
    type: "number",
    default: "1500",
    placeholder: "1500",
    description:
      "Stops calling Hardcover once this many requests were made in a UTC day. Hardcover's free plan allows 5,000 a day and 60 a minute, so the default leaves plenty of room. 0 turns the guard off. The count is kept in data/hardcover/usage.json.",
  },
  {
    key: "debugMatching",
    fieldset: "Troubleshooting",
    advanced: true,
    label: "Explain matching in the log",
    type: "toggle",
    default: "false",
    description:
      "On: every lookup writes one block to the server log that shows the candidates Hardcover returned, how well each title fits, the popularity numbers, and why the panel showed or not. Rejected title-like queries get one line saying which rule rejected them. Only the query text and catalog titles are logged, never the token. Off by default.",
  },
];
