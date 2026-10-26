import { generateKeyPairSync } from "node:crypto";

// A VAPID key pair: P-256, both halves base64url. The public key is the uncompressed point 0x04 || x || y (65 bytes).
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const { x, y } = publicKey.export({ format: "jwk" });
const { d } = privateKey.export({ format: "jwk" });
const publicRaw = Buffer.concat([Buffer.from([4]), Buffer.from(x, "base64url"), Buffer.from(y, "base64url")]).toString("base64url");

console.log(`VAPID_PUBLIC_KEY  (a var in wrangler.jsonc):\n${publicRaw}\n`);
console.log(`VAPID_PRIVATE_KEY (a secret, never commit it):\n${d}\n`);
console.log("Store the private key with:\n  npx wrangler secret put VAPID_PRIVATE_KEY\n");
console.log('Also set VAPID_SUBJECT in wrangler.jsonc to a "mailto:" address or an https URL that push services can contact.');
console.log("Do not rotate these keys later: every browser would have to subscribe again.");
