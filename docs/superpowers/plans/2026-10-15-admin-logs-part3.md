# Admin Log Viewer Plan — Part 3: Task 3 code, Task 4 HTML and JS

[← Part 2](2026-10-15-admin-logs-part2.md) · [Part 4: CSS, check, docs →](2026-10-15-admin-logs-part4.md)

## `test/admin-logs.test.ts`

```ts
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { adminCall, createClient, setupAdmin } from "./helpers";

let cookie: string;
let clientId: string;

async function insert(level: string, code: string, extra: { client_id?: string; message_id?: string; ip?: string } = {}): Promise<number> {
  return (await env.DB.prepare("INSERT INTO app_logs (created_at, level, code, client_id, message_id, ip) VALUES (unixepoch(), ?, ?, ?, ?, ?) RETURNING id")
    .bind(level, code, extra.client_id ?? null, extra.message_id ?? null, extra.ip ?? null)
    .first<number>("id"))!;
}

async function get(query = ""): Promise<any> {
  const res = await adminCall(`logs${query}`, { cookie });
  expect(res.status).toBe(200);
  return res.json();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM app_logs").run();
  cookie = await setupAdmin();
  clientId = (await createClient("shop")).id;
});

describe("GET /admin/api/logs", () => {
  it("requires a session, and logs that rejection as a warn with no client", async () => {
    expect((await adminCall("logs")).status).toBe(401);
    expect(await env.DB.prepare("SELECT level, code, client_id, path FROM app_logs").first()).toEqual({
      level: "warn", code: "unauthorized", client_id: null, path: "/admin/api/logs",
    });
  });

  it("filters by each field and names the client", async () => {
    const target = await insert("error", "smtp_failed", { client_id: clientId, message_id: "msg_x", ip: "203.0.113.7" });
    await insert("warn", "unauthorized", { ip: "198.51.100.1" });
    const ids = async (query: string) => (await get(`?${query}`)).logs.map((l: any) => l.id);
    for (const query of ["level=error", "code=smtp_failed", `client_id=${clientId}`, "ip=203.0.113.7", "message_id=msg_x"]) {
      expect(await ids(query)).toEqual([target]);
    }
    expect((await get()).logs.map((l: any) => l.client_name)).toEqual([null, "shop"]);
  });

  it("pages newest first by id and never repeats a row", async () => {
    for (let i = 0; i < 55; i++) await insert("info", `code_${i}`);
    const first = await get();
    expect(first.logs).toHaveLength(50);
    const second = await get(`?before=${first.next}`);
    expect(second.logs).toHaveLength(5);
    expect(second.next).toBeNull();
    const seen = [...first.logs, ...second.logs].map((l: any) => l.code);
    expect(new Set(seen).size).toBe(55);
    expect(seen[0]).toBe("code_54");
  });

  it("rejects a bad level or cursor, and is not cacheable", async () => {
    for (const query of ["level=fatal", "before=abc", "before=0", "before=-1"]) {
      expect((await adminCall(`logs?${query}`, { cookie })).status).toBe(400);
    }
    expect((await adminCall("logs", { cookie })).headers.get("Cache-Control")).toBe("no-store");
  });
});
```

## `logs` handler (append to `src/admin/stats.ts`)

```ts
const LEVELS = ["error", "warn", "info"];
const LOG_FILTERS = ["level", "code", "client_id", "ip", "message_id"] as const;

export async function logs(req: Request, env: Env): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const where: string[] = [];
  const binds: (string | number)[] = [];
  for (const field of LOG_FILTERS) {
    const value = params.get(field);
    if (!value) continue;
    if (field === "level" && !LEVELS.includes(value)) invalid("level must be one of error, warn, info");
    where.push(`l.${field} = ?`); // field comes from LOG_FILTERS, never from the request
    binds.push(value);
  }
  const before = params.get("before");
  if (before) {
    if (!/^[1-9]\d{0,15}$/.test(before)) invalid("before must be a cursor returned as next");
    where.push("l.id < ?");
    binds.push(Number(before));
  }
  const { results } = await env.DB.prepare(
    `SELECT l.*, c.name AS client_name FROM app_logs l LEFT JOIN clients c ON c.id = l.client_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY l.id DESC LIMIT ?`,
  )
    .bind(...binds, PAGE + 1)
    .all<{ id: number }>();
  const page = results.slice(0, PAGE);
  return Response.json({ logs: page, next: results.length > PAGE ? page[PAGE - 1].id : null });
}
```

---

### Task 4: Logs section in the dashboard

**Interfaces:**
- **Consumes:** `GET /admin/api/logs` → `{logs, next}`.
- **Produces:** a page-local `pager()`, which replaces `loadDeliveries`'s hand-written paging.

- [ ] **Step 1: `index.html`.** After `<button id="more" type="button" hidden>Load more</button>`, add:

```html
    <h2 id="logs-title">Logs</h2>
    <form id="log-search" class="search">
      <select name="level" aria-label="Level">
        <option value="">Any level</option><option>error</option><option>warn</option><option>info</option>
      </select>
      <input name="code" placeholder="Code" aria-label="Code">
      <input name="client_id" placeholder="Client id" aria-label="Client id">
      <input name="ip" placeholder="IP" aria-label="IP">
      <input name="message_id" placeholder="msg_…" aria-label="Message id">
      <button>Search</button>
      <p class="error" role="alert"></p>
    </form>
    <div class="scroll">
      <table id="logs"><thead><tr><th>Time</th><th>Level</th><th>Code</th><th>Status</th><th>Request</th><th>Client</th>
        <th>Message</th><th>IP</th><th>Detail</th></tr></thead><tbody></tbody></table>
    </div>
    <button id="more-logs" type="button" hidden>Load more</button>
```

- [ ] **Step 2: `app.js`.**
  - Delete `let cursor = null;`, the whole `async function loadDeliveries(reset) {…}`, the line `onSubmit($("#search"), () => loadDeliveries(true));` and the `$("#more").addEventListener("click", …)` block.
  - In `refresh()`, after `await loadDeliveries(true);`, add `await loadLogs(true);`.
  - Where `loadDeliveries` was, add:

```js
/** A filter form, a table and a "Load more" button over a cursor-paged API list. Returns load(reset). */
function pager(path, formSelector, tableSelector, moreSelector, listKey, toRow) {
  const form = $(formSelector);
  const body = $(`${tableSelector} tbody`);
  const more = $(moreSelector);
  let cursor = null;
  async function load(reset) {
    if (reset) {
      cursor = null;
      body.replaceChildren();
    }
    const params = new URLSearchParams([...new FormData(form)].filter(([, v]) => v));
    if (cursor !== null) params.set("before", cursor);
    const data = await api(`${path}?${params}`);
    body.append(...data[listKey].map(toRow));
    cursor = data.next;
    more.hidden = cursor === null;
  }
  onSubmit(form, () => load(true));
  more.addEventListener("click", async () => {
    // Disabled while loading: a double click would fetch the same cursor twice and duplicate rows.
    more.disabled = true;
    await load(false).catch(showError);
    more.disabled = false;
  });
  return load;
}

function link(cell, onClick) {
  cell.classList.add("link");
  cell.addEventListener("click", onClick);
}

function showLogs(field, value) {
  const form = $("#log-search");
  form.reset();
  form.elements[field].value = value;
  loadLogs(true).catch(showError);
  $("#logs-title").scrollIntoView();
}

const loadDeliveries = pager("deliveries", "#search", "#deliveries", "#more", "deliveries", (d) => {
  const tr = row([time(d.created_at), d.id, d.client_name, d.template, d.recipient, d.status, d.attempts, d.error_code, time(d.sent_at)]);
  link(tr.children[1], () => showLogs("message_id", d.id));
  return tr;
});

const loadLogs = pager("logs", "#log-search", "#logs", "#more-logs", "logs", (l) => {
  const request = [l.method, l.path].filter(Boolean).join(" ");
  const tr = row([time(l.created_at), l.level, l.code, l.status, request, l.client_name ?? l.client_id, l.message_id, l.ip, l.detail]);
  tr.children[1].className = `level-${l.level}`;
  if (l.ip) link(tr.children[7], () => showLogs("ip", l.ip));
  return tr;
});
```

- [ ] **Steps 3–6:** continue in [Part 4](2026-10-15-admin-logs-part4.md).
