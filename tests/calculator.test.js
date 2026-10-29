// Tests for the calculator slot plugin: expression engine, gating table, units, bases, formatting, rendering and settings.
import { afterEach, describe, expect, test } from "bun:test";
import { evaluate, parseExpression, tokenize } from "../plugins/calculator/expr.js";
import { fractionHint, formatValue, prettyExpression, radixForms, toBase } from "../plugins/calculator/format.js";
import { analyse } from "../plugins/calculator/match.js";
import { buildCard } from "../plugins/calculator/render.js";
import { SETTINGS_SCHEMA } from "../plugins/calculator/settings.js";
import { CalculatorSlot, INLINE_POSITION, PANEL_POSITION, angleFrom, digitsFrom, layoutFrom, slot as sharedSlot } from "../plugins/calculator/index.js";
import { convertValue, findUnit } from "../plugins/calculator/units.js";

const calc = (text, angle = "radians", digits = 12) => {
  const parsed = parseExpression(text);
  if (!parsed) return null;
  const result = evaluate(parsed.tree, { angle });
  if (!result.ok) return result.error;
  return formatValue(result.value, { digits, separators: false }).plain;
};

describe("expression engine", () => {
  const table = [
    ["2+2", "4"],
    ["2 + 3 * 4", "14"],
    ["(2 + 3) * 4", "20"],
    ["2^10", "1024"],
    ["2**10", "1024"],
    ["2^3^2", "512"],
    ["-2^2", "-4"],
    ["2^-1", "0.5"],
    ["10 / 4", "2.5"],
    ["10 / 5", "2"],
    ["7 % 3", "1"],
    ["10 % 3", "1"],
    ["2(3+4)", "14"],
    ["(1+2)(3+4)", "21"],
    ["2pi", "6.28318530718"],
    ["2 × 3 ÷ 4", "1.5"],
    ["3 x 4", "12"],
    ["3·4", "12"],
    ["1,234.5 + 1", "1235.5"],
    ["1e3 + 1", "1001"],
    ["1.5e3 * 2", "3000"],
    ["0.1 + 0.2", "0.3"],
    ["0xff + 1", "256"],
    ["0b101 * 2", "10"],
    ["sqrt(16)", "4"],
    ["√9", "3"],
    ["cbrt(27)", "3"],
    ["abs(-4.5)", "4.5"],
    ["floor(2.7) + ceil(2.1)", "5"],
    ["round(2.567, 1)", "2.6"],
    ["ln(e)", "1"],
    ["log(1000)", "3"],
    ["log2(8)", "3"],
    ["exp(0)", "1"],
    ["max(1, 5, 3)", "5"],
    ["min(4, 2)", "2"],
    ["pow(2, 8)", "256"],
    ["mod(17, 5)", "2"],
    ["fact(5)", "120"],
    ["5!", "120"],
    ["sin(pi)", "0"],
    ["cos(0)", "1"],
    ["tan(0)", "0"],
    ["atan(1) * 4", "3.14159265359"],
    ["2^100", "1267650600228229401496703205376"],
    ["20!", "2432902008176640000"],
    ["100!/98!", "9900"],
    ["15% of 80", "12"],
    ["15 percent of 80", "12"],
    ["80 + 15%", "92"],
    ["80 - 15%", "68"],
    ["20% off 45", "36"],
    ["50%", "0.5"],
    ["1/3", "0.333333333333"],
    ["1e400", "overflow"],
    ["1/0", "div0"],
    ["0^-1", "div0"],
    ["sqrt(-1)", "domain"],
    ["ln(0)", "domain"],
    ["(-8)^0.5", "domain"],
  ];
  for (const [text, expected] of table) {
    test(`${text} = ${expected}`, () => expect(calc(text)).toBe(expected));
  }

  test("degrees and radians", () => {
    expect(calc("sin(30)", "degrees")).toBe("0.5");
    expect(calc("sin(30 deg)", "radians")).toBe("0.5");
    expect(calc("sin(pi/6 rad)", "degrees")).toBe("0.5");
    expect(calc("sin(pi/6)", "radians")).toBe("0.5");
    expect(calc("asin(0.5)", "degrees")).toBe("30");
    expect(calc("cos(60°)", "radians")).toBe("0.5");
  });

  test("integers are exact, floats are trimmed", () => {
    expect(calc("2^200")).toBe((2n ** 200n).toString());
    expect(calc("0.1*3")).toBe("0.3");
    expect(calc("1/3", "radians", 6)).toBe("0.333333");
  });

  test("caps", () => {
    expect(calc("1000!")).not.toBeNull();
    expect(calc("1001!")).toBe("overflow");
    expect(calc("10^5001")).toBe("overflow");
    expect(calc("9^9^9")).toBe("overflow");
    expect(parseExpression("1+".repeat(101))).toBeNull();
    expect(parseExpression("(".repeat(41) + "1" + ")".repeat(41))).toBeNull();
    expect(parseExpression(`${"(".repeat(30)}1${")".repeat(30)}`)).not.toBeNull();
  });

  test("never throws on hostile input", () => {
    for (const text of ["", " ", "(", ")", "((((", "1 +", "* 2", "sqrt(", "1 2", "2e", "e e", "1,,2", "\u0000", "2 ** ** 3", "a+b", "__proto__", "constructor", "1..2", "0x", "0xzz", "1e99999", "%", "!", "5!!!!", "pow(1)", "min()", "x"]) {
      expect(() => parseExpression(text)).not.toThrow();
      const parsed = parseExpression(text);
      if (parsed) expect(() => evaluate(parsed.tree)).not.toThrow();
    }
    expect(tokenize("<script>alert(1)</script>")).toBeNull();
    expect(parseExpression("alert(1)")).toBeNull();
    expect(parseExpression("process.exit()")).toBeNull();
  });
});

describe("gating table", () => {
  const positives = [
    "2+2", "2 + 2", "2*3", "100/4", "10 - 3", "2^8", "7 x 6", "3 × 4", "17 % 5", "(1+2)*3", "1,000 * 3", "1.5 * 2", "sqrt(16)", "sqrt 16",
    "sin(30)", "cos(pi)", "log(100)", "ln(10)", "5!", "fact(6)", "20!", "2pi", "pi * 2", "e ^ 2", "15% of 80", "20% off 45", "what is 15 percent of 80",
    "80 + 15%", "what is 2+2", "what's 12 * 12", "calculate 5 * 5", "calc 9 x 9", "compute 3^4", "solve 6*7", "= 4*4", "2+2=", "2+2 =", "12*12?", "0xff + 1",
    "what is 1/0", "what is 24/7", "calc 24/7", "max(1,2)", "round(2.5)", "5 km to miles", "100 f to c", "12 cups in ml", "255 in hex", "255 to binary", "0xff in decimal",
    "10 kg in lb", "3 days in hours", "100°F to °C", "5 gb to mb", "50 mph to km/h", "2 ft in in", "1 acre to m2", "10 / 3", "1 / 8", "1 / 2 + 1 / 3",
    "2 * 3 * 4", "100 - 1", "7 + 3", "9 ^ 2", "1e3 + 1", "10 - 3 - 2", "2(3+4)", "3 x 4", "3x 4",
  ];
  const negatives = [
    "", " ", "2", "42", "2026", "1,000", "3.14", "-5", "100%", "pi", "e", "tau", "2026-10-28", "28/10/2026", "10.28.2026", "3.5.1", "192.168.1.1", "1-2", "10-5", "555-1234",
    "555-123-4567", "(555) 123-4567", "+1 555 123 4567", "24/7", "9/11", "1/2", "4x4", "1920x1080", "iphone 15 pro", "playstation 5", "windows 11", "ubuntu 22.04", "python 3.11",
    "c++", "covid-19", "x-men", "7-eleven", "t-shirt", "blink 182", "area 51", "route 66", "catch 22", "2 pac", "weather", "hello world", "what is love", "what is a calculator",
    "calculator", "calc", "what is", "solve", "round 6", "max 3", "floor 2", "https://example.com/2+2", "user@example.com", "www.example.com", "a+b", "x+1", "2 apples + 3",
    "100 usd to eur", "100 dollars in euros", "50 gbp to yen", "1 btc to usd", "100 pounds to usd", "5 to 10", "km to miles", "5 km to usd", "5 km to kg", "255 in decimal",
    "1 in a million", "2 in 1 laptop", "3 to 1", "version 2.0", "top 10", "10 best games", "2+", "+", "*", "(", "()", "sqrt", "sin", "!", "5 +* 3", "1 2 3", "1,2,3", "2e", "ten plus ten",
  ];
  for (const query of positives) {
    test(`positive: ${JSON.stringify(query)}`, () => {
      const result = analyse(query);
      expect(result.answer, result.reason).not.toBeNull();
    });
  }
  for (const query of negatives) {
    test(`negative: ${JSON.stringify(query)}`, () => {
      const result = analyse(query);
      expect(result.answer, `${query} -> ${JSON.stringify(result.answer?.kind)}`).toBeNull();
    });
  }

  test("a query that is far too long never triggers", () => {
    expect(analyse("1+".repeat(200)).answer).toBeNull();
  });
});

describe("what a card says", () => {
  const value = (query, angle) => formatValue(analyse(query, { angle }).answer.value, { digits: 12, separators: true }).text;
  test("percent forms", () => {
    expect(value("15% of 80")).toBe("12");
    expect(value("80 + 15%")).toBe("92");
    expect(value("what is 15 percent of 80")).toBe("12");
    const breakdown = analyse("15% of 80").answer.percent;
    expect(breakdown).toMatchObject({ x: 15, y: 80, of: 12, plus: 92, minus: 68 });
    expect(analyse("20% off 45").answer.percent).toMatchObject({ mode: "off", minus: 36 });
    expect(analyse("80 - 15%").answer.percent).toMatchObject({ mode: "minus", minus: 68 });
    expect(analyse("2+2").answer.percent).toBeNull();
  });

  test("percent and modulo are not confused", () => {
    expect(value("10 % 3")).toBe("1");
    expect(value("15% of 80")).toBe("12");
    expect(analyse("10 % 3").answer.percent).toBeNull();
  });

  test("division by zero is undefined, not an error page", () => {
    const answer = analyse("what is 1/0").answer;
    expect(answer.error).toBe("div0");
    const html = buildCard(answer, { layout: "inline" });
    expect(html).toContain("undefined");
    expect(html).not.toContain("data-copy");
  });

  test("units", () => {
    const answer = analyse("5 km to miles").answer;
    expect(answer.kind).toBe("units");
    expect(answer.result).toBeCloseTo(3.1068559611866697, 9);
    expect(answer.others.length).toBeGreaterThanOrEqual(3);
    const f = analyse("100 f to c").answer;
    expect(f.result).toBeCloseTo(37.7778, 3);
    expect(analyse("-40 c to f").answer.result).toBeCloseTo(-40, 9);
    expect(analyse("0 k to c").answer.result).toBeCloseTo(-273.15, 9);
  });

  test("unit names, aliases and plurals", () => {
    for (const [name, key] of [["kilometers", "km"], ["kilometres", "km"], ["pounds", "lb"], ["lbs", "lb"], ["fahrenheit", "f"], ["°F", "f"], ["°C", "c"], ["degrees celsius", "c"], ["Miles per hour", "mph"], ["fl oz", "fl oz"], ["square feet", "sq ft"], ["m2", "m2"], ["Feet", "ft"], ["GiB", "GiB"], ["gb", "GB"], ["b", "bit"], ["B", "B"], ["nautical miles", "nmi"], ["knots", "kn"], ["tablespoons", "tbsp"]]) {
      expect(findUnit(name)?.key, name).toBe(key);
    }
    for (const name of ["usd", "eur", "dollars", "euros", "btc", "bitcoin", "yen", "", "xyz"]) expect(findUnit(name), name).toBeNull();
    expect(convertValue(1, findUnit("gib"), findUnit("mib"))).toBe(1024);
    expect(convertValue(1, findUnit("kb"), findUnit("B"))).toBe(1000);
    expect(convertValue(1, findUnit("km"), findUnit("kg"))).toBeNull();
    expect(convertValue(60, findUnit("min"), findUnit("h"))).toBe(1);
    expect(convertValue(1, findUnit("gal"), findUnit("qt"))).toBeCloseTo(4, 9);
  });

  test("currency words never become unit conversions", () => {
    for (const query of ["100 usd to eur", "5 dollars to euros", "1 btc to usd", "20 eur in gbp", "50 pounds sterling to usd"]) expect(analyse(query).answer, query).toBeNull();
    expect(analyse("5 pounds to kg").answer?.kind).toBe("units");
  });

  test("bases", () => {
    const hex = analyse("255 in hex").answer;
    expect(toBase(hex.value, hex.base)).toBe("0xFF");
    const bin = analyse("10 to binary").answer;
    expect(toBase(bin.value, bin.base)).toBe("0b1010");
    const oct = analyse("64 as octal").answer;
    expect(toBase(oct.value, oct.base)).toBe("0o100");
    const dec = analyse("0xff in decimal").answer;
    expect(toBase(dec.value, dec.base)).toBe("255");
    expect(toBase({ k: "int", v: -255n }, 16)).toBe("-0xFF");
    expect(toBase({ k: "num", v: 1.5 }, 16)).toBeNull();
    expect(analyse("2.5 in hex").answer).toBeNull();
    expect(radixForms({ k: "int", v: 255n })).toEqual({ hex: "0xFF", bin: "0b1111 1111", oct: "0o377" });
    expect(radixForms({ k: "int", v: 2n ** 130n })).toBeNull();
  });
});

describe("formatting", () => {
  const f = (v, digits = 12, separators = true) => formatValue(v, { digits, separators });
  test("integers", () => {
    expect(f({ k: "int", v: 1234567n }).text).toBe("1,234,567");
    expect(f({ k: "int", v: 1234567n }, 12, false).text).toBe("1234567");
    expect(f({ k: "int", v: -1234n }).text).toBe("-1,234");
    expect(f({ k: "int", v: 2n ** 100n }).text).toBe("1,267,650,600,228,229,401,496,703,205,376");
    const huge = f({ k: "int", v: 10n ** 100n });
    expect(huge.text).toBe("1 × 10¹⁰⁰");
    expect(huge.approximate).toBe(true);
    expect(f({ k: "int", v: 3n ** 150n }).text).toMatch(/× 10⁷¹$/);
  });
  test("floats", () => {
    expect(f({ k: "num", v: 0.1 + 0.2 }).text).toBe("0.3");
    expect(f({ k: "num", v: 0.49999999999999994 }).text).toBe("0.5");
    expect(f({ k: "num", v: 1234.5678 }).text).toBe("1,234.5678");
    expect(f({ k: "num", v: 1 / 3 }, 6).text).toBe("0.333333");
    expect(f({ k: "num", v: 1e25 }).text).toBe("1 × 10²⁵");
    expect(f({ k: "num", v: 1.5e-9 }).text).toBe("1.5 × 10⁻⁹");
    expect(f({ k: "num", v: 0 }).text).toBe("0");
    expect(f({ k: "num", v: -0 }).text).toBe("0");
    expect(f({ k: "num", v: 123456789.123456789 }, 15).text).toBe("123,456,789.123457");
    expect(f({ k: "num", v: 1234.5 }, 12, false).plain).toBe("1234.5");
  });
  test("fractions", () => {
    expect(fractionHint(0.375)).toBe("3/8");
    expect(fractionHint(1 / 3)).toBe("1/3");
    expect(fractionHint(-0.75)).toBe("-3/4");
    expect(fractionHint(2.5)).toBe("5/2");
    expect(fractionHint(Math.PI)).toBeNull();
    expect(fractionHint(0.123456789)).toBeNull();
    expect(fractionHint(4)).toBeNull();
    expect(fractionHint(Number.NaN)).toBeNull();
  });
  test("pretty expressions", () => {
    const pretty = (text) => prettyExpression(parseExpression(text).tokens);
    expect(pretty("2*(3+4)")).toBe("2 × (3 + 4)");
    expect(pretty("10/4")).toBe("10 ÷ 4");
    expect(pretty("2^10")).toBe("2¹⁰");
    expect(pretty("2**3")).toBe("2³");
    expect(pretty("-5 + 3")).toBe("−5 + 3");
    expect(pretty("2pi")).toBe("2 π");
    expect(pretty("sqrt(16)")).toBe("√(16)");
    expect(pretty("5!")).toBe("5!");
    expect(pretty("15% of 80")).toBe("15% of 80");
    expect(pretty("max(1,2)")).toBe("max(1, 2)");
    expect(pretty("1,234.5 * 2")).toBe("1,234.5 × 2");
    expect(pretty("2^(1+2)")).toBe("2^(1 + 2)");
  });
});

const makeSlot = (settings = {}) => {
  const slot = new CalculatorSlot();
  slot.configure(settings);
  return slot;
};

describe("rendering", () => {
  test("hostile text is escaped", () => {
    const answer = analyse("2+2").answer;
    answer.tokens = [{ t: "num", raw: '<img src=x onerror="alert(1)">' }];
    const html = buildCard(answer, { layout: "inline" });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain('onerror="');
  });

  test("inline is more detailed than panel", async () => {
    const inline = makeSlot({ layout: "inline" });
    const panel = makeSlot({ layout: "panel" });
    for (const query of ["2^10", "15% of 80", "5 km to miles", "255 in hex", "1/8 + 1/4"]) {
      const a = (await inline.execute(query)).html;
      const b = (await panel.execute(query)).html;
      expect(a).toContain("calculator-card--inline");
      expect(b).toContain("calculator-card--panel");
      expect(a.length, query).toBeGreaterThan(b.length);
    }
    const html = (await inline.execute("15% of 80")).html;
    expect(html).toContain("calculator-rows");
    expect(html).toContain("92");
    expect(html).toContain("68");
    const units = (await inline.execute("5 km to miles")).html;
    expect(units).toContain("calculator-grid");
    const big = (await inline.execute("2^10")).html;
    expect(big).toContain("0x400");
    expect(big).toContain("0b100 0000 0000");
    const small = (await panel.execute("2^10")).html;
    expect(small).not.toContain("calculator-chips");
    expect(small).toContain("1,024");
  });

  test("the copy button copies the plain number", async () => {
    const html = (await makeSlot().execute("1000*1000")).html;
    expect(html).toContain('data-copy="1000000"');
    expect(html).toContain("1,000,000");
    const plain = (await makeSlot({ thousandsSeparators: "false" }).execute("1000*1000")).html;
    expect(plain).toContain("1000000");
    expect(plain).not.toContain("1,000,000");
  });

  test("angle mode and digits come from the settings", async () => {
    expect((await makeSlot({ angleMode: "degrees" }).execute("sin(30)")).html).toContain(">0.5<");
    expect((await makeSlot({ significantDigits: "6" }).execute("1 / 3")).html).toContain("0.333333");
    expect((await makeSlot({ significantDigits: "6" }).execute("1 / 3")).html).not.toContain("0.3333333");
  });

  test("the template wraps the card", async () => {
    const result = await makeSlot().execute("2+2");
    expect(result.html.startsWith('<div class="command-result calculator-result">')).toBe(true);
    expect(result.title).toBe("");
  });

  test("a query that is not a calculation gives an empty result", async () => {
    expect(await makeSlot().execute("hello")).toEqual({ title: "", html: "" });
  });
});

describe("settings and layout", () => {
  test("position follows the layout", () => {
    const slot = new CalculatorSlot();
    expect(slot.position).toBe(INLINE_POSITION);
    slot.configure({ layout: "panel" });
    expect(slot.position).toBe(PANEL_POSITION);
    slot.configure({ layout: "inline" });
    expect(slot.position).toBe(INLINE_POSITION);
    slot.configure({});
    expect(slot.layout).toBe("inline");
    slot.configure({ layout: "nonsense" });
    expect(slot.position).toBe(INLINE_POSITION);
    expect(slot.slotPositions).toBeUndefined();
  });

  test("clamping and defaults", () => {
    expect(digitsFrom("3")).toBe(6);
    expect(digitsFrom("99")).toBe(15);
    expect(digitsFrom("abc")).toBe(12);
    expect(digitsFrom(undefined)).toBe(12);
    expect(digitsFrom("9")).toBe(9);
    expect(layoutFrom("PANEL")).toBe("panel");
    expect(layoutFrom(undefined)).toBe("inline");
    expect(angleFrom("Degrees")).toBe("degrees");
    expect(angleFrom("x")).toBe("radians");
  });

  test("the schema has the documented keys and a default layout of inline", () => {
    const keys = SETTINGS_SCHEMA.map((field) => field.key);
    expect(keys).toEqual(["layout", "thousandsSeparators", "angleMode", "significantDigits", "debugMatching"]);
    const layout = SETTINGS_SCHEMA.find((field) => field.key === "layout");
    expect(layout.default).toBe("inline");
    expect(layout.options).toEqual(["inline", "panel"]);
    expect(layout.optionLabels[0]).toContain("Inline");
    expect(SETTINGS_SCHEMA.find((field) => field.key === "debugMatching")).toMatchObject({ advanced: true, default: "false" });
    expect(SETTINGS_SCHEMA.some((field) => field.required)).toBe(false);
  });

  test("the angle mode changes the trigger-independent answer", () => {
    expect(makeSlot({ angleMode: "degrees" }).trigger("sin(30)")).toBe(true);
  });
});

describe("debugMatching", () => {
  const capture = (work) => {
    const lines = [];
    const original = console.info;
    console.info = (...args) => lines.push(args.join(" "));
    try {
      work();
    } finally {
      console.info = original;
    }
    return lines;
  };

  test("off by default: nothing is logged", () => {
    expect(capture(() => makeSlot().trigger("2+2"))).toEqual([]);
  });

  test("on: one line per query with a digit, with the reason", () => {
    const slot = makeSlot({ debugMatching: "true" });
    const accepted = capture(() => slot.trigger("2+2"));
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toContain("taken as math expression");
    const rejected = capture(() => slot.trigger("2026-10-28"));
    expect(rejected[0]).toContain("looks like a date");
    expect(capture(() => slot.trigger("hello world"))).toEqual([]);
  });
});

describe("one menu entry", () => {
  test("the module exports a slot and no bang command (a command would add a second entry to degoog's plugin list)", async () => {
    const mod = await import("../plugins/calculator/index.js");
    expect(mod.slot).toBe(sharedSlot);
    expect("command" in mod).toBe(false);
    expect("default" in mod).toBe(false);
  });
});
