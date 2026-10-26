export const SETTINGS_SCHEMA = [
  {
    key: "refreshHours",
    label: "Refresh the app list every (hours)",
    type: "number",
    default: "24",
    placeholder: "24",
    description:
      "6 to 720. The list is downloaded once (five small files, about 370 KB), kept on disk, and searched locally, so searches make no network requests. Refreshes ask only whether anything changed.",
  },
  {
    key: "perPage",
    label: "Results per page",
    type: "number",
    default: "20",
    placeholder: "20",
    description: "5 to 50.",
  },
  {
    key: "activeOnly",
    label: "Hide apps with no update in over a year",
    type: "toggle",
    default: "false",
    description: "Uses selfh.st's own inactive marker.",
  },
  {
    key: "openSourceOnly",
    label: "Hide closed-source apps",
    type: "toggle",
    default: "false",
    description: "Hides apps selfh.st lists as closed or proprietary.",
  },
];
