export const SETTINGS_SCHEMA = [
  {
    key: "apiKey",
    label: "API key (optional)",
    type: "password",
    secret: true,
    placeholder: "Mwmbl API key",
    description:
      "Works without a key. A key from mwmbl.org (account, API keys) gives a free allowance of 2,000 searches a month and counts your usage. Saved on the server and sent only as a header. MWMBL_API_KEY in the container environment is used when this is empty.",
  },
  {
    key: "perPage",
    label: "Results per page",
    type: "number",
    default: "10",
    placeholder: "10",
    description:
      "5 to 50. Mwmbl answers with all its results (up to about 70) in one response, which is kept for 10 minutes, so later pages cost no extra request.",
  },
  {
    key: "requireSnippet",
    label: "Hide results without a description",
    type: "toggle",
    default: "false",
    description: "Mwmbl's index is small and many of its pages have no extract. Turn this on to hide those results.",
  },
];
