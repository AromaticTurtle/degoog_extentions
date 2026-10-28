import { fractionHint, formatValue, prettyExpression, radixForms, toBase } from "./format.js";
import { categoryLabel, unitLabel } from "./units.js";

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';

const ERRORS = { div0: "undefined", domain: "undefined (not a real number)", overflow: "too large to show", syntax: "undefined" };

const copyButton = (text, layout) =>
  text
    ? `<button class="calculator-copy" type="button" data-copy="${esc(text)}" aria-label="Copy the answer" title="Copy">${COPY_ICON}${layout === "inline" ? '<span class="calculator-copy-label">Copy</span>' : ""}</button>`
    : "";

const chip = (label, text) => `<span class="calculator-chip"><span class="calculator-chip-label">${esc(label)}</span><span class="calculator-chip-value">${esc(text)}</span></span>`;

const INPUT_NUMBER = (n, options) => formatValue({ k: "num", v: n }, options).text;
const SHORT_NUMBER = (n, options) => formatValue({ k: "num", v: n }, { ...options, digits: Math.min(options.digits, 7) }).text;

// -> { kicker, expression, value, copy, secondary: [[label, text]], extra: "html" }
const describe = (answer, options) => {
  if (answer.kind === "units") {
    // conversions read better with fewer digits than a calculation: 3.106856 mi, not 3.10685596119 mi
    options = { ...options, digits: Math.min(options.digits, 8) };
    const result = formatValue({ k: "num", v: answer.result }, options);
    const from = `${INPUT_NUMBER(answer.amount, options)} ${unitLabel(answer.from)}`;
    const unit = unitLabel(answer.to);
    const others = answer.others.map(({ unit: u, value }) => [unitLabel(u), SHORT_NUMBER(value, options)]);
    return {
      kicker: `Unit conversion · ${categoryLabel(answer.from)}`,
      expression: `${from} =`,
      value: result.text,
      unit,
      copy: `${result.plain} ${unit}`,
      secondary: others.map(([label, text]) => [label, text]),
      grid: others,
    };
  }
  if (answer.kind === "base") {
    const text = toBase(answer.value, answer.base) ?? "too large to show";
    const names = { 2: "binary", 8: "octal", 10: "decimal", 16: "hexadecimal" };
    const label = { 16: "Hex", 2: "Bin", 8: "Oct", 10: "Dec" };
    const rows = [16, 2, 8, 10].filter((b) => b !== answer.base).map((b) => [label[b], toBase(answer.value, b)]).filter(([, t]) => t);
    return {
      kicker: `Number base · ${names[answer.base]}`,
      expression: `${prettyExpression(answer.tokens)} in ${names[answer.base]} =`,
      value: text,
      copy: text,
      secondary: rows,
    };
  }
  // math
  const expression = `${prettyExpression(answer.tokens)} =`;
  if (answer.error) {
    return { kicker: "Calculator", expression, value: ERRORS[answer.error] ?? "undefined", error: true, copy: "", secondary: [] };
  }
  const result = formatValue(answer.value, options);
  const secondary = [];
  if (answer.value.k === "int") {
    const forms = radixForms(answer.value);
    if (result.scientific && result.digitCount > 6) secondary.push(["Scientific", result.scientific]);
    if (result.digitCount > 60) secondary.push(["Digits", String(result.digitCount)]);
    if (forms) {
      secondary.push(["Hex", forms.hex], ["Bin", forms.bin], ["Oct", forms.oct]);
    }
  } else {
    const fraction = fractionHint(answer.value.v);
    if (fraction) secondary.push(["Fraction", fraction]);
    if (result.scientific) secondary.push(["Scientific", result.scientific]);
  }
  const kicker = answer.percent ? "Calculator · Percentage" : "Calculator";
  return { kicker, expression, value: result.text, copy: result.plain, secondary, percent: answer.percent };
};

const percentRows = (percent, options) => {
  const rows = [
    [`${INPUT_NUMBER(percent.x, options)}% of ${INPUT_NUMBER(percent.y, options)}`, SHORT_NUMBER(percent.of, options)],
    [`${INPUT_NUMBER(percent.y, options)} + ${INPUT_NUMBER(percent.x, options)}%`, SHORT_NUMBER(percent.plus, options)],
    [`${INPUT_NUMBER(percent.y, options)} − ${INPUT_NUMBER(percent.x, options)}%`, SHORT_NUMBER(percent.minus, options)],
  ];
  return `<div class="calculator-rows">${rows.map(([label, value]) => `<div class="calculator-row"><span class="calculator-row-label">${esc(label)}</span><span class="calculator-row-value">${esc(value)}</span></div>`).join("")}</div>`;
};

const gridOf = (items) =>
  `<div class="calculator-grid">${items.map(([label, value]) => `<div class="calculator-cell"><span class="calculator-cell-value">${esc(value)}</span><span class="calculator-cell-label">${esc(label)}</span></div>`).join("")}</div>`;

// layout: "inline" (detailed) or "panel" (compact)
export const buildCard = (answer, { layout = "inline", digits = 12, separators = true } = {}) => {
  const options = { digits, separators };
  const d = describe(answer, options);
  const size = d.value.length > 28 ? " calculator-value--xlong" : d.value.length > 14 ? " calculator-value--long" : "";
  const valueHtml = `<span class="calculator-value-number">${esc(d.value)}</span>${d.unit ? `<span class="calculator-value-unit">${esc(d.unit)}</span>` : ""}`;
  const head = `<div class="calculator-kicker">${esc(d.kicker)}</div><div class="calculator-expression" title="${esc(d.expression)}">${esc(d.expression)}</div><div class="calculator-answer"><div class="calculator-value${d.error ? " calculator-value--error" : ""}${size}">${valueHtml}</div>${copyButton(d.copy, layout)}</div>`;
  if (layout === "panel") {
    const first = d.secondary.slice(0, answer.kind === "units" ? 2 : 1);
    const cell = ([label, text]) => (answer.kind === "units" ? `<span><b>${esc(text)}</b> ${esc(label)}</span>` : `<span>${esc(label)} <b>${esc(text)}</b></span>`);
    const line = first.length ? `<div class="calculator-secondary-line">${first.map(cell).join('<span class="calculator-dot" aria-hidden="true">·</span>')}</div>` : "";
    return `<div class="calculator-card calculator-card--panel">${head}${line}</div>`;
  }
  let body = "";
  if (d.percent) body += percentRows(d.percent, options);
  if (answer.kind === "units" && d.grid.length) body += `<div class="calculator-also">Also</div>${gridOf(d.grid)}`;
  else if (d.secondary.length) body += `<div class="calculator-chips">${d.secondary.map(([label, text]) => chip(label, text)).join("")}</div>`;
  return `<div class="calculator-card calculator-card--inline">${head}${body}</div>`;
};
