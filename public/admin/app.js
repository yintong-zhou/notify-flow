// notify-flow admin dashboard. Caller-controlled values go in through textContent only, never innerHTML.
const $ = (selector) => document.querySelector(selector);
const SVG_NS = "http://www.w3.org/2000/svg";
const CARDS = ["submitted", "failed", "stalled", "processing", "queued", "retrying", "accepted"];
const COLORS = { submitted: "#2e9e5b", failed: "#d64545", processing: "#3b82f6", retrying: "#e0a020", queued: "#8a8f98", accepted: "#7c5cd6" };
const SPANS = { "24h": [86400, 3600], "7d": [604800, 86400], "30d": [2592000, 86400] }; // [span, bucket], as on the server

async function api(path, body) {
  const init = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(`/admin/api/${path}`, init);
  // A Cloudflare error page is HTML: fall back to the HTTP status instead of a JSON parse error.
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.ok) return data;
  // Only a missing or expired session goes back to login: a wrong current password is invalid_credentials.
  if (data?.error?.code === "unauthorized") show("login");
  throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
}

function show(id) {
  for (const section of document.querySelectorAll("main > section")) section.hidden = section.id !== id;
  if (id === "dashboard") refresh();
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

const time = (seconds) => (seconds ? new Date(seconds * 1000).toLocaleString() : "");
const showError = (e) => ($("#dash-error").textContent = e.message);

function row(cells) {
  const tr = el("tr");
  tr.append(...cells.map((cell) => el("td", String(cell ?? ""))));
  return tr;
}

function onSubmit(form, handler) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    for (const p of form.querySelectorAll(".error, .ok")) p.textContent = "";
    try {
      await handler(Object.fromEntries(new FormData(form)));
    } catch (e) {
      form.querySelector(".error").textContent = e.message;
    }
  });
}

async function refresh() {
  $("#dash-error").textContent = "";
  try {
    const stats = await api(`stats?window=${$("#window").value}`);
    renderCards(stats.by_status);
    renderChart(stats);
    renderErrors(stats.errors);
    await loadDeliveries(true);
    await loadLogs(true);
  } catch (e) {
    showError(e);
  }
}

function renderCards(byStatus) {
  $("#cards").replaceChildren(
    ...CARDS.map((status) => {
      const card = el("div", undefined, `card ${status}`);
      card.append(el("span", status), el("strong", String(byStatus[status])));
      return card;
    }),
  );
}

function renderErrors(errors) {
  $("#errors tbody").replaceChildren(
    ...errors.map((e) => {
      const tr = row([e.error_code, e.client_name, e.template, e.count]);
      tr.addEventListener("click", () => {
        $("#search").reset();
        $("#search").elements.error_code.value = e.error_code;
        loadDeliveries(true).catch(showError);
      });
      return tr;
    }),
  );
}

function renderChart({ window, series }) {
  const [span, step] = SPANS[window];
  const now = Math.floor(Date.now() / 1000);
  const buckets = new Map();
  for (let b = now - span - ((now - span) % step); b <= now; b += step) buckets.set(b, {});
  for (const p of series) if (buckets.has(p.bucket)) buckets.get(p.bucket)[p.status] = p.count;
  const max = Math.max(1, ...[...buckets.values()].map((c) => Object.values(c).reduce((a, n) => a + n, 0)));
  const [width, height] = [600, 160];
  const barWidth = width / buckets.size;
  const svg = $("#chart");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.replaceChildren();
  [...buckets].forEach(([bucket, counts], i) => {
    let y = height;
    for (const [status, color] of Object.entries(COLORS)) {
      const n = counts[status];
      if (!n) continue;
      const h = (n / max) * height;
      y -= h;
      const rect = document.createElementNS(SVG_NS, "rect");
      const attrs = { x: i * barWidth + 1, y, width: Math.max(barWidth - 2, 1), height: h, fill: color };
      for (const [k, v] of Object.entries(attrs)) rect.setAttribute(k, v);
      const title = document.createElementNS(SVG_NS, "title");
      title.textContent = `${time(bucket)} · ${status}: ${n}`;
      rect.append(title);
      svg.append(rect);
    }
  });
  $("#legend").replaceChildren(
    ...Object.entries(COLORS).map(([status, color]) => {
      const item = el("span", status);
      item.style.setProperty("--swatch", color);
      return item;
    }),
  );
}

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

onSubmit($("#setup-form"), async (values) => {
  await api("setup", values);
  $("#setup-form").reset();
  show("dashboard");
});
onSubmit($("#login-form"), async (values) => {
  await api("login", values);
  $("#login-form").reset();
  show("dashboard");
});
onSubmit($("#password-form"), async (values) => {
  await api("password", values);
  $("#password-form").reset();
  $("#password-form .ok").textContent = "Password changed. Other sessions were logged out.";
});
$("#window").addEventListener("change", refresh);
$("#refresh").addEventListener("click", refresh);
$("#logout").addEventListener("click", () => api("logout", {}).then(() => show("login"), showError));

api("me")
  .then((me) => show(!me.registered ? "setup" : me.logged_in ? "dashboard" : "login"))
  .catch((e) => (document.body.textContent = e.message));
