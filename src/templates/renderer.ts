import { HttpError, type Locale, type Template } from "../types";
import { builtinTemplate } from "./defaults";

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export interface Rendered {
  subject: string;
  html: string;
  text: string;
}

export function placeholders(source: string): string[] {
  return [...source.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

// Single pass: substituted values are never scanned again.
function fill(source: string, vars: Record<string, string>, encode: (value: string) => string): string {
  return source.replace(PLACEHOLDER, (_, name: string) => encode(Object.hasOwn(vars, name) ? vars[name] : ""));
}

export function render(template: Template, vars: Record<string, string>): Rendered {
  return {
    subject: fill(template.subject, vars, (v) => v.replace(/[\r\n]/g, "")).trim(),
    html: fill(template.html, vars, (v) => v.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])),
    text: fill(template.text, vars, (v) => v),
  };
}

export function checkVariables(template: Template, vars: Record<string, string>): void {
  const declared = new Set(template.variables);
  const missing = template.variables.filter((name) => !Object.hasOwn(vars, name));
  const unexpected = Object.keys(vars).filter((name) => !declared.has(name));
  if (missing.length || unexpected.length) {
    throw new HttpError(
      400,
      "invalid_variables",
      `missing: [${missing.join(", ")}], unexpected: [${unexpected.join(", ")}]`,
    );
  }
}

interface TemplateRow {
  subject: string;
  html: string;
  text: string;
  variables: string;
}

export async function findTemplate(
  db: D1Database,
  clientId: string,
  name: string,
  locale: Locale,
): Promise<{ template: Template; builtin: boolean } | null> {
  const row = await db
    .prepare("SELECT subject, html, text, variables FROM templates WHERE client_id = ? AND name = ? AND locale = ?")
    .bind(clientId, name, locale)
    .first<TemplateRow>();
  if (row) {
    return {
      template: { subject: row.subject, html: row.html, text: row.text, variables: JSON.parse(row.variables) },
      builtin: false,
    };
  }
  const builtin = builtinTemplate(name, locale);
  return builtin ? { template: builtin, builtin: true } : null;
}

export async function resolveTemplate(db: D1Database, clientId: string, name: string, locale: Locale): Promise<Template> {
  for (const candidate of new Set<Locale>([locale, "en"])) {
    const found = await findTemplate(db, clientId, name, candidate);
    if (found) return found.template;
  }
  throw new HttpError(404, "template_not_found", `Template "${name}" not found`);
}
