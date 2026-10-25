import { fill } from "../templates/renderer";
import { HttpError, type Locale } from "../types";

export interface PushTemplate {
  title: string;
  body: string;
  variables: string[];
}

const NEW_MESSAGE = ["appName", "sender"];

// Push templates are separate from email templates: built-in only, plain text.
const PUSH_TEMPLATES: Record<string, Partial<Record<Locale, PushTemplate>>> = {
  "new-message": {
    it: { title: "{{appName}}", body: "Hai ricevuto una notifica da {{sender}}", variables: NEW_MESSAGE },
    en: { title: "{{appName}}", body: "You received a notification from {{sender}}", variables: NEW_MESSAGE },
    "pt-BR": { title: "{{appName}}", body: "Você recebeu uma notificação de {{sender}}", variables: NEW_MESSAGE },
  },
};

export function resolvePushTemplate(name: string, locale: Locale): PushTemplate {
  // Object.hasOwn: a name like "constructor" must not resolve through the prototype.
  const byLocale = Object.hasOwn(PUSH_TEMPLATES, name) ? PUSH_TEMPLATES[name] : undefined;
  const found = byLocale?.[locale] ?? byLocale?.en;
  if (!found) throw new HttpError(404, "template_not_found", `Template "${name}" not found`);
  return found;
}

export function renderPush(t: PushTemplate, vars: Record<string, string>): { title: string; body: string } {
  const plain = (value: string) => value;
  return { title: fill(t.title, vars, plain), body: fill(t.body, vars, plain) };
}
