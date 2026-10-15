// Database section: lists the tables and runs admin-written SQL through POST /admin/api/sql.
// Uses $, el, row, onSubmit and api from app.js. Values go in through textContent only, never innerHTML.
const DB_PAGE = 50;
// "_" is a LIKE wildcard: escaped, so only sqlite_* and _cf_* (D1 internals) are hidden.
const LIST_TABLES =
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name";
const dbForm = $("#db-form");
const dbPrev = $("#db-prev");
const dbNext = $("#db-next");
let dbPage = null; // { table, offset } while a table is browsed

const quoteName = (name) => `"${name.replaceAll('"', '""')}"`;
const showCell = (v) => (v === null ? "NULL" : typeof v === "object" ? JSON.stringify(v) : v);

function renderResult({ columns, rows, truncated, meta }, shown = rows) {
  const head = el("tr");
  head.append(...columns.map((c) => el("th", c)));
  $("#db-result thead").replaceChildren(head);
  $("#db-result tbody").replaceChildren(
    ...shown.map((r) => {
      const tr = row(columns.map((c) => showCell(r[c])));
      for (const td of tr.children) td.title = td.textContent;
      return tr;
    }),
  );
  const parts = [`${shown.length} rows`, `${meta.changes} changes`, `${meta.duration} ms`];
  if (truncated) parts.push("showing the first 1000");
  $("#db-status").textContent = parts.join(" · ");
}

async function loadTables() {
  const { rows } = await api("sql", { sql: LIST_TABLES });
  $("#db-tables").replaceChildren(
    ...rows.map(({ name }) => {
      const button = el("button", name);
      button.type = "button";
      button.addEventListener("click", () => browse(name, 0));
      return button;
    }),
  );
}

async function browse(table, offset) {
  const sql = `SELECT * FROM ${quoteName(table)} LIMIT ${DB_PAGE + 1} OFFSET ${offset}`;
  dbForm.elements.sql.value = sql;
  dbForm.querySelector(".error").textContent = "";
  try {
    const data = await api("sql", { sql });
    dbPage = { table, offset };
    renderResult(data, data.rows.slice(0, DB_PAGE));
    dbPrev.hidden = offset === 0;
    dbNext.hidden = data.rows.length <= DB_PAGE;
  } catch (e) {
    dbForm.querySelector(".error").textContent = e.message;
  }
}

onSubmit(dbForm, async ({ sql }) => {
  dbPage = null;
  dbPrev.hidden = dbNext.hidden = true;
  $("#db-status").textContent = "";
  renderResult(await api("sql", { sql }));
  await loadTables(); // a CREATE or DROP shows at once
});
dbForm.elements.sql.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) dbForm.requestSubmit();
});
dbPrev.addEventListener("click", () => browse(dbPage.table, dbPage.offset - DB_PAGE));
dbNext.addEventListener("click", () => browse(dbPage.table, dbPage.offset + DB_PAGE));
