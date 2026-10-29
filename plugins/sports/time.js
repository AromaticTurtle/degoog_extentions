// Time zones and the short date words on the card. Pure; never throws.

export const validZone = (value) => {
  const zone = String(value ?? "").trim();
  if (!zone || zone.length > 60 || !/^[A-Za-z0-9_+\-/]+$/.test(zone)) return "";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return "";
  }
};

export const serverZone = () => validZone(Intl.DateTimeFormat().resolvedOptions().timeZone) || "UTC";

const partsOf = (ts, zone, options) => {
  const out = {};
  for (const part of new Intl.DateTimeFormat("en-US", { timeZone: zone, ...options }).formatToParts(new Date(ts))) out[part.type] = part.value;
  return out;
};

// "2026-10-30" in the zone
export const dayKey = (ts, zone) => {
  try {
    const p = partsOf(ts, zone, { year: "numeric", month: "2-digit", day: "2-digit" });
    return `${p.year}-${p.month}-${p.day}`;
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
};

const DAY_MS = 86_400_000;

// whole calendar days from now to ts in the zone (0 = today, 1 = tomorrow, -1 = yesterday)
export const dayDiff = (ts, now, zone) => {
  const a = Date.parse(`${dayKey(ts, zone)}T00:00:00Z`);
  const b = Date.parse(`${dayKey(now, zone)}T00:00:00Z`);
  return Math.round((a - b) / DAY_MS);
};

// ESPN's scoring day is the US Eastern date: 20261030
export const espnDate = (ts) => dayKey(ts, "America/New_York").replace(/-/g, "");

// "Sun 1:00 PM EDT", "Today 8:15 PM EDT", "Tomorrow 1:00 PM EDT", "Nov 8, 1:00 PM EST"
export const kickoffLabel = (ts, now, zone) => {
  try {
    const p = partsOf(ts, zone, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" });
    const clock = `${p.hour}:${p.minute} ${String(p.dayPeriod ?? "").toUpperCase()}`.trim();
    const diff = dayDiff(ts, now, zone);
    const day = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday" : diff > 1 && diff < 7 ? p.weekday : `${p.month} ${p.day},`;
    return `${day} ${clock} ${p.timeZoneName ?? ""}`.trim();
  } catch {
    return "";
  }
};

// "Oct 30" for the date of a finished game
export const shortDate = (ts, zone) => {
  try {
    const p = partsOf(ts, zone, { month: "short", day: "numeric" });
    return `${p.month} ${p.day}`;
  } catch {
    return "";
  }
};

// The calendar day the query asks about, as ESPN's date parameter: "" means the board ESPN calls current.
export const whenToDate = (when, now) => {
  if (when === "yesterday") return espnDate(now - DAY_MS);
  if (when === "tomorrow") return espnDate(now + DAY_MS);
  return "";
};
