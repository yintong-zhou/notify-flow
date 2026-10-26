import { expect, it } from "vitest";
import { b64url, deriveKeys, encryptPayload, importPrivateKey, vapidAuthorization } from "../src/push/crypto";
import { browserKeys, decryptPush } from "./helpers";

// RFC 8291 section 5 example, verbatim.
const AS_PUBLIC = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const SALT = "DGv6ra1nlYgDCS1FRnbzlw";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
const EXPECTED =
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";
const enc = (s: string) => new TextEncoder().encode(s);

it("reproduces the RFC 8291 example byte for byte", async () => {
  const asPublic = b64url.decode(AS_PUBLIC);
  const ephemeral = { privateKey: await importPrivateKey(b64url.decode(AS_PRIVATE), asPublic, "ECDH"), publicRaw: asPublic, salt: b64url.decode(SALT) };
  const out = await encryptPayload(enc("When I grow up, I want to be a watermelon"), b64url.decode(UA_PUBLIC), b64url.decode(AUTH), ephemeral);
  expect(b64url.encode(out)).toBe(EXPECTED);
});

it("derives the RFC 8291 appendix A key and nonce", async () => {
  const keys = await deriveKeys(b64url.decode("kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs"), b64url.decode(AUTH),
    b64url.decode(UA_PUBLIC), b64url.decode(AS_PUBLIC), b64url.decode(SALT));
  expect(b64url.encode(keys.cek)).toBe("oIhVW04MRdy2XN9CiKLxTg");
  expect(b64url.encode(keys.nonce)).toBe("4h_95klXJ5E_qnoN");
});

it("encrypts with a fresh key and salt that the browser can decrypt", async () => {
  const browser = await browserKeys();
  const [a, b] = await Promise.all([1, 2].map(() => encryptPayload(enc("hello"), b64url.decode(browser.p256dh), b64url.decode(browser.auth))));
  expect(await decryptPush(a, browser)).toBe("hello");
  expect(a.length).toBe(86 + 5 + 1 + 16); // header + plaintext + 0x02 delimiter + GCM tag
  expect(b64url.encode(a.slice(0, 16))).not.toBe(b64url.encode(b.slice(0, 16))); // new salt per message
});

it("signs an ES256 VAPID JWT for the endpoint origin", async () => {
  const keys = { publicKey: AS_PUBLIC, privateKey: AS_PRIVATE, subject: "mailto:ops@example.com" };
  const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, 1_700_000_000_000);
  const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
  expect(k).toBe(AS_PUBLIC);
  const [h, c, s] = t.split(".");
  const json = (part: string) => JSON.parse(new TextDecoder().decode(b64url.decode(part)));
  expect(json(h)).toEqual({ typ: "JWT", alg: "ES256" });
  expect(json(c)).toEqual({ aud: "https://fcm.googleapis.com", exp: 1_700_000_000 + 43200, sub: "mailto:ops@example.com" });
  const pub = await crypto.subtle.importKey("raw", b64url.decode(AS_PUBLIC), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64url.decode(s), enc(`${h}.${c}`))).toBe(true);
});

it("b64url.decode rejects anything but unpadded base64url", () => {
  for (const bad of ["a+b/", "ab c", "ab=="]) expect(() => b64url.decode(bad)).toThrow();
});
