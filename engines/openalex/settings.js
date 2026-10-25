export const SETTINGS_SCHEMA = [
  {
    key: "apiKey",
    label: "API key (optional)",
    type: "password",
    secret: true,
    placeholder: "OpenAlex API key",
    description:
      "Works without a key on a small daily budget. A free key from openalex.org (Settings, API key) raises it tenfold. Saved on the server and never sent back to the browser. OPENALEX_API_KEY in the container environment is used when this is empty.",
  },
  {
    key: "perPage",
    label: "Results per page",
    type: "number",
    default: "10",
    placeholder: "10",
    description: "1 to 50. Each page is one search request, which is the most expensive kind OpenAlex has.",
  },
  {
    key: "openAccessOnly",
    label: "Open access only",
    type: "toggle",
    default: "false",
    description: "Only return works with a free-to-read version.",
  },
];
