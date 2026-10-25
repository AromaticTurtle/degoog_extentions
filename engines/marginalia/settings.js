export const SETTINGS_SCHEMA = [
  {
    key: "apiKey",
    label: "API key",
    type: "password",
    secret: true,
    placeholder: "Marginalia API key",
    description:
      "Free for non-commercial use: email contact@marginalia-search.com. Saved on the server and never sent back to the browser. MARGINALIA_API_KEY in the container environment is used when this is empty.",
  },
  {
    key: "count",
    label: "Results per page",
    type: "number",
    default: "20",
    placeholder: "20",
    description: "1 to 100. Each page costs one API request.",
  },
  {
    key: "maxPerDomain",
    label: "Max results per domain",
    type: "number",
    default: "2",
    placeholder: "2",
    description: "Asked of Marginalia directly. 0 turns the limit off.",
  },
  {
    key: "reduceExplicit",
    label: "Reduce explicit results",
    type: "toggle",
    default: "false",
    description: "Marginalia's experimental filter for extreme results.",
  },
];
