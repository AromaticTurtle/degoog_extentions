export const SETTINGS_SCHEMA = [
  {
    key: "triggerWords",
    fieldset: "Trigger",
    label: "Trigger words",
    type: "text",
    default: "reddit",
    placeholder: "reddit",
    description:
      "Comma separated, letters and digits only. When one of them is the first or last word of a query, it is removed and 'site:reddit.com' is added, so your web engines return Reddit pages: 'best homelab os reddit' searches 'best homelab os site:reddit.com'.",
  },
  {
    key: "position",
    fieldset: "Trigger",
    label: "Where the word may be",
    type: "select",
    options: ["either", "first", "last"],
    optionLabels: ["First or last word", "Only the first word", "Only the last word"],
    default: "either",
    description: "A trigger word in the middle of a query ('my reddit account') never does anything.",
  },
  {
    key: "enableBang",
    fieldset: "Trigger",
    label: "Also react to !reddit and !rl",
    type: "toggle",
    default: "true",
    description:
      "'!reddit best homelab os' and '!rl best homelab os'. degoog's web page sends bang queries to its command handler, not to query interceptors, so there the bang is answered by the small !reddit command of this plugin, which jumps to the rewritten search; direct calls to the search API are rewritten by the interceptor.",
  },
  {
    key: "alsoTrigger",
    fieldset: "Trigger",
    label: "Append site:reddit.com when the query names a subreddit like r/homelab",
    type: "toggle",
    default: "true",
    description: "'r/homelab best os' becomes 'best os site:reddit.com/r/homelab', without the word reddit.",
  },
  {
    key: "skipQuestions",
    fieldset: "Trigger",
    label: "Leave short questions about Reddit alone",
    type: "toggle",
    default: "true",
    description:
      "'what is reddit', 'who owns reddit' and 'how do I use reddit' (a question word first and at most four other words) stay as they are. Put the word first ('reddit how do I...') to force the lens.",
  },
  {
    key: "showNotice",
    fieldset: "Display",
    label: "Show a notice when a query was rewritten",
    type: "toggle",
    default: "true",
    description:
      "A small note above the results: 'Showing web results from Reddit for best homelab os'. degoog keeps showing what you typed in the search box.",
  },
];
