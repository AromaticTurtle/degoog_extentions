export const SETTINGS_SCHEMA = [
  {
    key: "apiKey",
    label: "API key",
    type: "password",
    secret: true,
    placeholder: "CORE API key",
    description:
      "Free key from core.ac.uk/services/api. Saved on the server and never sent back to the browser. CORE_API_KEY in the container environment is used when this is empty. Without a key this engine does nothing.",
  },
  {
    key: "perPage",
    label: "Results per page",
    type: "number",
    default: "10",
    placeholder: "10",
    description: "10 to 50. Each page is one API request against CORE's small quota.",
  },
];
