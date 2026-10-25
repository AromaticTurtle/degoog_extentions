export const SETTINGS_SCHEMA = [
  {
    key: "accessKey",
    label: "API access key (optional)",
    type: "password",
    secret: true,
    placeholder: "Unsplash access key",
    description:
      "From unsplash.com/developers (register an application). Used for the official API: demo apps get 50 requests an hour. Saved on the server, sent only as a header, never shown again. UNSPLASH_ACCESS_KEY in the container environment is used when this is empty.",
  },
  {
    key: "webFallback",
    label: "Use the Unsplash website when the API is unavailable",
    type: "toggle",
    default: "true",
    description:
      "Without a key, or once the hourly API quota is used up, search through the website's own JSON endpoint. That endpoint is undocumented, can change or be blocked at any time, and is currently behind a bot check that degoog may refuse to solve (see the README). A free API key is the reliable option. Turn this off to use the official API only.",
  },
  {
    key: "perPage",
    label: "Results per page",
    type: "number",
    default: "20",
    placeholder: "20",
    description: "10 to 30.",
  },
];
