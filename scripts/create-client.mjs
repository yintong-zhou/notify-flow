import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const [name, target = "--local"] = process.argv.slice(2);
if (!name || !["--local", "--remote"].includes(target)) {
  console.error("Usage: npm run client:create -- <name> [--remote]");
  process.exit(1);
}

const id = `cl_${randomUUID()}`;
const key = `nf_${randomBytes(32).toString("base64url")}`;
const keyHash = createHash("sha256").update(key).digest("hex");
const sql = `INSERT INTO clients (id, name, key_hash, created_at) VALUES ('${id}', '${name.replaceAll("'", "''")}', '${keyHash}', unixepoch());`;

// Run wrangler through node directly: no shell, so the SQL argument is passed verbatim on every OS.
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
execFileSync(process.execPath, [wrangler, "d1", "execute", "notify-flow", target, "--command", sql], { stdio: "inherit" });

console.log(`\nClient id: ${id}\nAPI key (shown only once, store it now): ${key}`);
