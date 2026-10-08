import { parseTemplate, parseTemplateKey, readJson } from "../security/validation";
import { listBuiltins } from "../templates/defaults";
import { findTemplate } from "../templates/renderer";
import { HttpError } from "../types";

export async function listTemplates(env: Env, clientId: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT name, locale, updated_at FROM templates WHERE client_id = ? ORDER BY name, locale",
  )
    .bind(clientId)
    .all<{ name: string; locale: string; updated_at: number }>();
  const own = new Set(results.map((r) => `${r.name}/${r.locale}`));
  return Response.json([
    ...results.map((r) => ({ ...r, builtin: false })),
    ...listBuiltins()
      .filter((b) => !own.has(`${b.name}/${b.locale}`))
      .map((b) => ({ ...b, builtin: true, updated_at: null })),
  ]);
}

export async function getTemplate(env: Env, clientId: string, rawName: string, rawLocale: string): Promise<Response> {
  const { name, locale } = parseTemplateKey(rawName, rawLocale);
  const found = await findTemplate(env.DB, clientId, name, locale);
  if (!found) throw new HttpError(404, "template_not_found", `Template "${name}" (${locale}) not found`);
  return Response.json({ name, locale, ...found.template, builtin: found.builtin });
}

export async function putTemplate(req: Request, env: Env, clientId: string, rawName: string, rawLocale: string): Promise<Response> {
  const { name, locale } = parseTemplateKey(rawName, rawLocale);
  const template = parseTemplate(await readJson(req));
  await env.DB.prepare(
    `INSERT INTO templates (client_id, name, locale, subject, html, text, variables, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT (client_id, name, locale) DO UPDATE SET
       subject = excluded.subject, html = excluded.html, text = excluded.text,
       variables = excluded.variables, updated_at = excluded.updated_at`,
  )
    .bind(clientId, name, locale, template.subject, template.html, template.text, JSON.stringify(template.variables))
    .run();
  return Response.json({ name, locale, ...template, builtin: false });
}

export async function deleteTemplate(env: Env, clientId: string, rawName: string, rawLocale: string): Promise<Response> {
  const { name, locale } = parseTemplateKey(rawName, rawLocale);
  const { meta } = await env.DB.prepare("DELETE FROM templates WHERE client_id = ? AND name = ? AND locale = ?")
    .bind(clientId, name, locale)
    .run();
  if (meta.changes === 0) throw new HttpError(404, "template_not_found", `Template "${name}" (${locale}) not found`);
  return new Response(null, { status: 204 });
}
