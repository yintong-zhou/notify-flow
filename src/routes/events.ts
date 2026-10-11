import { parseEvent, parseEventRoute, readJson } from "../security/validation";
import { BUILTIN_EVENTS, findEventRoute, templateExists } from "../templates/events";
import { HttpError } from "../types";

const eventNotFound = (event: string) => new HttpError(404, "event_not_found", `Event "${event}" not found`);

export async function listEvents(env: Env, clientId: string): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT event, template, updated_at FROM event_routes WHERE client_id = ? ORDER BY event")
    .bind(clientId)
    .all<{ event: string; template: string; updated_at: number }>();
  const own = new Set(results.map((r) => r.event));
  return Response.json([
    ...results.map((r) => ({ ...r, builtin: false })),
    ...Object.entries(BUILTIN_EVENTS)
      .filter(([event]) => !own.has(event))
      .map(([event, template]) => ({ event, template, builtin: true, updated_at: null })),
  ]);
}

export async function getEvent(env: Env, clientId: string, rawEvent: string): Promise<Response> {
  const event = parseEvent(rawEvent);
  const found = await findEventRoute(env.DB, clientId, event);
  if (!found) throw eventNotFound(event);
  return Response.json({ event, ...found });
}

export async function putEvent(req: Request, env: Env, clientId: string, rawEvent: string): Promise<Response> {
  const event = parseEvent(rawEvent);
  const { template } = parseEventRoute(await readJson(req));
  // Checked now, so a typo surfaces while configuring rather than on the first send.
  if (!(await templateExists(env.DB, clientId, template))) {
    throw new HttpError(404, "template_not_found", `Template "${template}" not found`);
  }
  await env.DB.prepare(
    `INSERT INTO event_routes (client_id, event, template, updated_at) VALUES (?, ?, ?, unixepoch())
     ON CONFLICT (client_id, event) DO UPDATE SET template = excluded.template, updated_at = excluded.updated_at`,
  )
    .bind(clientId, event, template)
    .run();
  return Response.json({ event, template, builtin: false });
}

export async function deleteEvent(env: Env, clientId: string, rawEvent: string): Promise<Response> {
  const event = parseEvent(rawEvent);
  const { meta } = await env.DB.prepare("DELETE FROM event_routes WHERE client_id = ? AND event = ?").bind(clientId, event).run();
  if (meta.changes === 0) throw eventNotFound(event);
  return new Response(null, { status: 204 });
}
