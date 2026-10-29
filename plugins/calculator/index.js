import { SETTINGS_SCHEMA } from "./settings.js";
import { analyse } from "./match.js";
import { formatValue } from "./format.js";
import { buildCard } from "./render.js";

// The inline layout puts the detailed card in the main column, above the results; the panel layout puts the compact card
// in the side column. The position follows the setting (no slotPositions are declared, so degoog uses `position`).
export const INLINE_POSITION = "above-results";
export const PANEL_POSITION = "knowledge-panel";
const FALLBACK_TEMPLATE = '<div class="command-result calculator-result">{{content}}</div>';
const EMPTY = { title: "", html: "" };

const truthy = (value, fallback) => (value === undefined || value === "" ? fallback : value === true || value === "true");

export const layoutFrom = (value) => (String(value ?? "").trim().toLowerCase() === "panel" ? "panel" : "inline");
export const angleFrom = (value) => (String(value ?? "").trim().toLowerCase() === "degrees" ? "degrees" : "radians");
export const digitsFrom = (value) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return 12;
  return Math.min(15, Math.max(6, parsed));
};

const summary = (answer) => {
  if (answer.kind === "units") return `${answer.amount} ${answer.from.key} -> ${answer.to.key}`;
  if (answer.error) return `error ${answer.error}`;
  if (answer.kind === "base") return `base ${answer.base}`;
  return `= ${formatValue(answer.value, { digits: 12, separators: false }).plain}`;
};

export class CalculatorSlot {
  isClientExposed = false;
  id = "calculator";
  name = "Calculator";
  description = "Calculator and unit converter card: arithmetic, percentages, functions, number bases and common units. No upstream, nothing leaves your server.";
  position = INLINE_POSITION;
  settingsSchema = SETTINGS_SCHEMA;

  layout = "inline";
  angle = "radians";
  digits = 12;
  separators = true;
  debugMatching = false;
  template = FALLBACK_TEMPLATE;

  init(context) {
    if (context?.template) this.template = context.template;
  }

  configure(settings = {}) {
    this.layout = layoutFrom(settings.layout);
    this.position = this.layout === "panel" ? PANEL_POSITION : INLINE_POSITION;
    this.angle = angleFrom(settings.angleMode);
    this.digits = digitsFrom(settings.significantDigits);
    this.separators = truthy(settings.thousandsSeparators, true);
    this.debugMatching = truthy(settings.debugMatching, false);
  }

  inspect(query) {
    return analyse(query, { angle: this.angle });
  }

  trigger(query) {
    try {
      const result = this.inspect(query);
      if (this.debugMatching && /\d/.test(String(query ?? ""))) {
        console.info(`[calculator] "${String(query).slice(0, 120)}" ${result.answer ? `taken as ${result.reason} (${summary(result.answer)})` : `not a calculation: ${result.reason}`} layout=${this.layout}`);
      }
      return Boolean(result.answer);
    } catch {
      return false;
    }
  }

  render(query) {
    const { answer } = this.inspect(query);
    if (!answer) return "";
    return buildCard(answer, { layout: this.layout, digits: this.digits, separators: this.separators });
  }

  async execute(query) {
    try {
      const html = this.render(query);
      if (!html) return EMPTY;
      return { title: "", html: this.template.replace(/\{\{content\}\}/g, () => html) };
    } catch {
      return EMPTY;
    }
  }
}

export const slot = new CalculatorSlot();
