// A small, dependency-free XML reader. It never throws, never expands custom or external entities
// (a DOCTYPE is skipped as a whole), and every loop only moves forward, so work stays linear in the input size.

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const HTML_NAMED = {
  ...NAMED,
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  bull: "•",
  middot: "·",
  times: "×",
  copy: "©",
  reg: "®",
  trade: "™",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  szlig: "ß",
};

const codePoint = (n) => {
  const valid =
    n === 9 || n === 10 || n === 13 || (n >= 32 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) && n !== 0xfffe && n !== 0xffff);
  return valid ? String.fromCodePoint(n) : "";
};

// The five XML entities and numeric references. Anything else (&custom;) is left as plain text.
export const decodeEntities = (text) => {
  const value = String(text ?? "");
  if (!value.includes("&")) return value;
  return value.replace(/&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|(amp|lt|gt|quot|apos));/g, (_match, hex, dec, name) =>
    name ? NAMED[name] : codePoint(hex ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10)),
  );
};

// BGG descriptions hold HTML entities inside the XML text, so a second pass with a few common named ones is needed.
export const decodeHtmlEntities = (text) => {
  const value = String(text ?? "");
  if (!value.includes("&")) return value;
  return value.replace(/&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([a-zA-Z]{2,8}));/g, (match, hex, dec, name) => {
    if (name) return Object.hasOwn(HTML_NAMED, name) ? HTML_NAMED[name] : match;
    return codePoint(hex ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10));
  });
};

const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 13;

// start is the index just after "<". Returns { name, attrs, selfClosing, end } or null for a malformed tag.
const readTag = (xml, start, maxAttrChars) => {
  const n = xml.length;
  let j = start;
  while (j < n) {
    const c = xml.charCodeAt(j);
    if (isSpace(c) || c === 47 || c === 62) break;
    j += 1;
  }
  const name = xml.slice(start, j);
  if (!name || name.length > 100 || !/^[A-Za-z_:][\w:.-]*$/.test(name)) return null;
  const attrs = Object.create(null);
  let count = 0;
  while (j < n) {
    let c = xml.charCodeAt(j);
    if (isSpace(c)) {
      j += 1;
      continue;
    }
    if (c === 62) return { name, attrs, selfClosing: false, end: j + 1 };
    if (c === 47) {
      if (xml.charCodeAt(j + 1) === 62) return { name, attrs, selfClosing: true, end: j + 2 };
      j += 1;
      continue;
    }
    const attrStart = j;
    while (j < n) {
      c = xml.charCodeAt(j);
      if (isSpace(c) || c === 61 || c === 62 || c === 47) break;
      j += 1;
    }
    const attrName = xml.slice(attrStart, j);
    while (j < n && isSpace(xml.charCodeAt(j))) j += 1;
    let value = "";
    if (xml.charCodeAt(j) === 61) {
      j += 1;
      while (j < n && isSpace(xml.charCodeAt(j))) j += 1;
      const quote = xml.charCodeAt(j);
      if (quote === 34 || quote === 39) {
        const close = xml.indexOf(quote === 34 ? '"' : "'", j + 1);
        if (close === -1) return null;
        value = xml.slice(j + 1, close);
        j = close + 1;
      } else {
        const valueStart = j;
        while (j < n) {
          c = xml.charCodeAt(j);
          if (isSpace(c) || c === 62) break;
          j += 1;
        }
        value = xml.slice(valueStart, j);
      }
    }
    if (attrName && count < 64) {
      attrs[attrName] = decodeEntities(value.slice(0, maxAttrChars));
      count += 1;
    }
  }
  return null;
};

// <!DOCTYPE ...> including an internal subset. It is only skipped, never interpreted.
const skipDeclaration = (xml, start, maxChars) => {
  const limit = Math.min(xml.length, start + maxChars);
  let depth = 0;
  let quote = 0;
  for (let j = start + 2; j < limit; j += 1) {
    const c = xml.charCodeAt(j);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) quote = c;
    else if (c === 91) depth += 1;
    else if (c === 93) depth -= 1;
    else if (c === 62 && depth <= 0) return j + 1;
  }
  return -1;
};

// Streams tokens to handlers.open(tag, attrs), close(tag) (also called for self-closing tags) and text(string).
// A handler can return false to stop. Resolves to "done", "truncated" (input longer than maxChars),
// "stopped" (a handler asked to stop) or "bad" (malformed or over a limit).
export const scanXml = (input, handlers = {}, limits = {}) => {
  const { maxChars = 2_000_000, maxTokens = 500_000, maxAttrChars = 20_000, maxDoctypeChars = 100_000 } = limits;
  if (typeof input !== "string") return "bad";
  const truncated = input.length > maxChars;
  // A reply cut at the size limit usually ends inside a tag, so only whole tags are kept.
  const xml = truncated ? input.slice(0, input.lastIndexOf(">", maxChars - 1) + 1) : input;
  const n = xml.length;
  let i = 0;
  let tokens = 0;
  while (i < n) {
    tokens += 1;
    if (tokens > maxTokens) return "bad";
    const lt = xml.indexOf("<", i);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i && handlers.text && handlers.text(decodeEntities(xml.slice(i, textEnd))) === false) return "stopped";
    if (lt === -1) break;
    i = lt;
    if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i + 4);
      if (end === -1) return "bad";
      i = end + 3;
    } else if (xml.startsWith("<![CDATA[", i)) {
      const end = xml.indexOf("]]>", i + 9);
      if (end === -1) return "bad";
      if (handlers.text && handlers.text(xml.slice(i + 9, end)) === false) return "stopped";
      i = end + 3;
    } else if (xml.startsWith("<?", i)) {
      const end = xml.indexOf("?>", i + 2);
      if (end === -1) return "bad";
      i = end + 2;
    } else if (xml.startsWith("<!", i)) {
      const end = skipDeclaration(xml, i, maxDoctypeChars);
      if (end === -1) return "bad";
      i = end;
    } else if (xml.startsWith("</", i)) {
      const end = xml.indexOf(">", i + 2);
      if (end === -1) return "bad";
      if (handlers.close && handlers.close(xml.slice(i + 2, end).trim()) === false) return "stopped";
      i = end + 1;
    } else {
      const tag = readTag(xml, i + 1, maxAttrChars);
      if (!tag) return "bad";
      if (handlers.open && handlers.open(tag.name, tag.attrs) === false) return "stopped";
      if (tag.selfClosing && handlers.close && handlers.close(tag.name) === false) return "stopped";
      i = tag.end;
    }
  }
  return truncated ? "truncated" : "done";
};

const MAX_NODE_TEXT = 200_000;

// Builds a small tree: { tag, attrs, children, text }. Returns null for anything that is not one complete,
// well nested document within the limits (depth, node count, size).
export const parseXml = (input, limits = {}) => {
  const { maxDepth = 32, maxNodes = 200_000 } = limits;
  try {
    let root = null;
    const stack = [];
    let nodes = 0;
    let failed = false;
    const status = scanXml(
      input,
      {
        open(tag, attrs) {
          if (stack.length >= maxDepth || nodes >= maxNodes || (!stack.length && root)) {
            failed = true;
            return false;
          }
          nodes += 1;
          const node = { tag, attrs, children: [], text: "" };
          if (stack.length) stack[stack.length - 1].children.push(node);
          else root = node;
          stack.push(node);
          return true;
        },
        close(tag) {
          const top = stack[stack.length - 1];
          if (!top || top.tag !== tag) {
            failed = true;
            return false;
          }
          stack.pop();
          return true;
        },
        text(value) {
          const top = stack[stack.length - 1];
          if (top && top.text.length < MAX_NODE_TEXT) top.text += value;
          return true;
        },
      },
      limits,
    );
    return status === "done" && !failed && root && stack.length === 0 ? root : null;
  } catch {
    return null;
  }
};

export const childrenOf = (node, tag) => (node && Array.isArray(node.children) ? node.children.filter((child) => child.tag === tag) : []);
export const firstChild = (node, tag) => childrenOf(node, tag)[0] ?? null;
export const attrOf = (node, name) => (node?.attrs && typeof node.attrs[name] === "string" ? node.attrs[name] : "");
