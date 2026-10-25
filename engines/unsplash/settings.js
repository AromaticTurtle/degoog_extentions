export const SETTINGS_SCHEMA = [
  {
    key: "accessKey",
    label: "API access key",
    type: "password",
    secret: true,
    placeholder: "Unsplash access key",
    description:
      "Required. Register an application at unsplash.com/developers and paste its access key. Demo applications get 50 requests an hour. Saved on the server, sent only as a header, never shown again. UNSPLASH_ACCESS_KEY in the container environment is used when this is empty. Without a key this engine does nothing.",
  },
  {
    key: "perPage",
    label: "Results per page",
    type: "number",
    default: "20",
    placeholder: "20",
    description: "10 to 30. Each page is one API request.",
  },
];
