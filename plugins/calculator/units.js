// Unit conversion tables. Every unit has a factor to the category's base unit (temperature has its own functions).
// Currency codes and names are NEVER handled here: "100 usd to eur" is left to the currency plugin.

const CATEGORIES = {
  length: {
    label: "Length",
    base: "m",
    related: ["m", "km", "cm", "in", "ft", "yd", "mi"],
    units: {
      mm: { f: 0.001, names: ["mm", "millimeter", "millimeters", "millimetre", "millimetres"] },
      cm: { f: 0.01, names: ["cm", "centimeter", "centimeters", "centimetre", "centimetres"] },
      m: { f: 1, names: ["m", "meter", "meters", "metre", "metres"] },
      km: { f: 1000, names: ["km", "kilometer", "kilometers", "kilometre", "kilometres"] },
      in: { f: 0.0254, names: ["in", "inch", "inches"] },
      ft: { f: 0.3048, names: ["ft", "foot", "feet"] },
      yd: { f: 0.9144, names: ["yd", "yard", "yards"] },
      mi: { f: 1609.344, names: ["mi", "mile", "miles"] },
      nmi: { f: 1852, names: ["nmi", "nautical mile", "nautical miles"] },
      ly: { f: 9460730472580800, names: ["ly", "light year", "light years", "lightyear", "lightyears"] },
    },
  },
  mass: {
    label: "Mass",
    base: "kg",
    related: ["kg", "g", "lb", "oz", "st", "t"],
    units: {
      mg: { f: 0.000001, names: ["mg", "milligram", "milligrams"] },
      g: { f: 0.001, names: ["g", "gram", "grams", "gramme", "grammes"] },
      kg: { f: 1, names: ["kg", "kilo", "kilos", "kilogram", "kilograms", "kilogramme", "kilogrammes"] },
      oz: { f: 0.028349523125, names: ["oz", "ounce", "ounces"] },
      lb: { f: 0.45359237, names: ["lb", "lbs", "pound", "pounds"] },
      st: { f: 6.35029318, names: ["st", "stone", "stones"] },
      t: { f: 1000, names: ["t", "tonne", "tonnes", "metric ton", "metric tons"] },
      ton: { f: 907.18474, names: ["ton", "tons", "short ton", "short tons"] },
    },
  },
  temperature: {
    label: "Temperature",
    base: "c",
    related: ["c", "f", "k"],
    units: {
      c: { names: ["c", "celsius", "centigrade", "degc", "degree celsius", "degrees celsius", "deg celsius", "deg c", "degrees c", "degree c"], toBase: (v) => v, fromBase: (v) => v },
      f: { names: ["f", "fahrenheit", "degf", "degree fahrenheit", "degrees fahrenheit", "deg fahrenheit", "deg f", "degrees f", "degree f"], toBase: (v) => ((v - 32) * 5) / 9, fromBase: (v) => (v * 9) / 5 + 32 },
      k: { names: ["k", "kelvin", "kelvins"], toBase: (v) => v - 273.15, fromBase: (v) => v + 273.15 },
    },
  },
  volume: {
    label: "Volume",
    base: "l",
    related: ["l", "ml", "cup", "fl oz", "pt", "qt", "gal"],
    units: {
      ml: { f: 0.001, names: ["ml", "milliliter", "milliliters", "millilitre", "millilitres"] },
      l: { f: 1, names: ["l", "liter", "liters", "litre", "litres"] },
      tsp: { f: 0.00492892159375, names: ["tsp", "teaspoon", "teaspoons"] },
      tbsp: { f: 0.01478676478125, names: ["tbsp", "tablespoon", "tablespoons"] },
      "fl oz": { f: 0.0295735295625, names: ["fl oz", "floz", "fluid ounce", "fluid ounces"] },
      cup: { f: 0.2365882365, names: ["cup", "cups"] },
      pt: { f: 0.473176473, names: ["pt", "pint", "pints"] },
      qt: { f: 0.946352946, names: ["qt", "quart", "quarts"] },
      gal: { f: 3.785411784, names: ["gal", "gallon", "gallons"] },
    },
  },
  speed: {
    label: "Speed",
    base: "m/s",
    related: ["m/s", "km/h", "mph", "kn"],
    units: {
      "m/s": { f: 1, names: ["m/s", "mps", "meters per second", "metres per second", "meter per second", "metre per second"] },
      "km/h": { f: 1000 / 3600, names: ["km/h", "kmh", "kph", "kmph", "kilometers per hour", "kilometres per hour", "kilometer per hour", "kilometre per hour"] },
      mph: { f: 0.44704, names: ["mph", "mi/h", "miles per hour", "mile per hour"] },
      kn: { f: 1852 / 3600, names: ["kn", "kt", "kts", "knot", "knots"] },
    },
  },
  area: {
    label: "Area",
    base: "m2",
    related: ["m2", "cm2", "km2", "ha", "acre", "sq ft", "sq mi"],
    units: {
      cm2: { f: 0.0001, names: ["cm2", "cm^2", "sq cm", "sqcm", "square centimeter", "square centimeters", "square centimetre", "square centimetres"] },
      m2: { f: 1, names: ["m2", "m^2", "sq m", "sqm", "square meter", "square meters", "square metre", "square metres"] },
      km2: { f: 1_000_000, names: ["km2", "km^2", "sq km", "sqkm", "square kilometer", "square kilometers", "square kilometre", "square kilometres"] },
      ha: { f: 10_000, names: ["ha", "hectare", "hectares"] },
      acre: { f: 4046.8564224, names: ["acre", "acres"] },
      "sq in": { f: 0.00064516, names: ["sq in", "sqin", "in2", "square inch", "square inches"] },
      "sq ft": { f: 0.09290304, names: ["sq ft", "sqft", "ft2", "ft^2", "square foot", "square feet"] },
      "sq mi": { f: 2589988.110336, names: ["sq mi", "sqmi", "mi2", "mi^2", "square mile", "square miles"] },
    },
  },
  data: {
    label: "Data",
    base: "B",
    related: ["B", "kB", "MB", "GB", "TB", "MiB", "GiB"],
    caseSensitive: ["b", "B"],
    units: {
      bit: { f: 0.125, names: ["b", "bit", "bits"] },
      B: { f: 1, names: ["B", "byte", "bytes"] },
      kB: { f: 1000, names: ["kb", "kilobyte", "kilobytes"] },
      MB: { f: 1e6, names: ["mb", "megabyte", "megabytes"] },
      GB: { f: 1e9, names: ["gb", "gigabyte", "gigabytes"] },
      TB: { f: 1e12, names: ["tb", "terabyte", "terabytes"] },
      PB: { f: 1e15, names: ["pb", "petabyte", "petabytes"] },
      KiB: { f: 1024, names: ["kib", "kibibyte", "kibibytes"] },
      MiB: { f: 1024 ** 2, names: ["mib", "mebibyte", "mebibytes"] },
      GiB: { f: 1024 ** 3, names: ["gib", "gibibyte", "gibibytes"] },
      TiB: { f: 1024 ** 4, names: ["tib", "tebibyte", "tebibytes"] },
    },
  },
  time: {
    label: "Time",
    base: "s",
    related: ["s", "min", "h", "day", "week", "month", "year"],
    units: {
      ms: { f: 0.001, names: ["ms", "millisecond", "milliseconds"] },
      s: { f: 1, names: ["s", "sec", "secs", "second", "seconds"] },
      min: { f: 60, names: ["min", "mins", "minute", "minutes"] },
      h: { f: 3600, names: ["h", "hr", "hrs", "hour", "hours"] },
      day: { f: 86400, names: ["d", "day", "days"] },
      week: { f: 604800, names: ["wk", "week", "weeks"] },
      month: { f: 2629746, names: ["mo", "month", "months"] },
      year: { f: 31556952, names: ["y", "yr", "yrs", "year", "years"] },
    },
  },
  pressure: {
    label: "Pressure",
    base: "Pa",
    related: ["Pa", "kPa", "bar", "psi", "atm"],
    units: {
      Pa: { f: 1, names: ["pa", "pascal", "pascals"] },
      kPa: { f: 1000, names: ["kpa", "kilopascal", "kilopascals"] },
      bar: { f: 100_000, names: ["bar", "bars"] },
      psi: { f: 6894.757293168, names: ["psi"] },
      atm: { f: 101325, names: ["atm", "atmosphere", "atmospheres"] },
      mmHg: { f: 133.322387415, names: ["mmhg", "torr"] },
    },
  },
  energy: {
    label: "Energy",
    base: "J",
    related: ["J", "kJ", "cal", "kcal", "Wh", "kWh"],
    units: {
      J: { f: 1, names: ["j", "joule", "joules"] },
      kJ: { f: 1000, names: ["kj", "kilojoule", "kilojoules"] },
      cal: { f: 4.184, names: ["cal", "calorie", "calories"] },
      kcal: { f: 4184, names: ["kcal", "kilocalorie", "kilocalories"] },
      Wh: { f: 3600, names: ["wh", "watt hour", "watt hours"] },
      kWh: { f: 3_600_000, names: ["kwh", "kilowatt hour", "kilowatt hours"] },
      BTU: { f: 1055.05585262, names: ["btu", "btus"] },
    },
  },
};

// name -> { category, key }
const INDEX = new Map();
for (const [category, spec] of Object.entries(CATEGORIES)) {
  for (const [key, unit] of Object.entries(spec.units)) {
    for (const name of unit.names) {
      const id = spec.caseSensitive?.includes(name) ? name : name.toLowerCase();
      if (!INDEX.has(id)) INDEX.set(id, { category, key });
    }
  }
}

const tidy = (text) =>
  String(text ?? "")
    .replace(/°/g, " deg ")
    .replace(/\s+/g, " ")
    .replace(/\.$/, "")
    .trim();

// "°F", "Fahrenheit", "kilometres", "fl oz" -> { category, key } or null
export const findUnit = (text) => {
  const raw = tidy(text);
  if (!raw) return null;
  // a bare "b" / "B" differs by case (bit vs byte); everything else is case-insensitive
  const exact = INDEX.get(raw);
  if (exact && CATEGORIES[exact.category].caseSensitive?.includes(raw)) return exact;
  const lower = raw.toLowerCase();
  const found = INDEX.get(lower) ?? INDEX.get(lower.replace(/^degrees? /, "").replace(/^deg /, ""));
  return found ?? null;
};

const unitsOf = (category) => CATEGORIES[category].units;

export const convertValue = (value, from, to) => {
  if (from.category !== to.category) return null;
  const spec = CATEGORIES[from.category];
  if (from.category === "temperature") {
    const a = spec.units[from.key];
    const b = spec.units[to.key];
    return b.fromBase(a.toBase(value));
  }
  return (value * spec.units[from.key].f) / spec.units[to.key].f;
};

export const unitLabel = (unit) => {
  const key = unit.key;
  if (unit.category === "temperature") return `°${key.toUpperCase()}`;
  return key;
};

export const categoryLabel = (unit) => CATEGORIES[unit.category].label;

// A few other units of the same kind, for the "also" grid on the inline card.
export const relatedUnits = (from, to, count = 4) => {
  const spec = CATEGORIES[from.category];
  const keys = spec.related.filter((key) => key !== from.key && key !== to.key && key in spec.units);
  return keys.slice(0, count).map((key) => ({ category: from.category, key }));
};

export const allUnitKeys = (category) => Object.keys(unitsOf(category));
export const UNIT_CATEGORIES = Object.keys(CATEGORIES);
