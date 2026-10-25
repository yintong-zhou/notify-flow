// Web Push cryptography on WebCrypto only: RFC 8291 payload encryption (aes128gcm) and RFC 8292 VAPID.

const text = new TextEncoder();

export const b64url = {
  encode(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  },
  /** Unpadded base64url only; throws on anything else. */
  decode(value: string): Uint8Array {
    if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("Invalid base64url");
    return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  },
};

/** Imports a P-256 private scalar `d`. WebCrypto only takes JWK for a private key, so the public point comes with it. */
export function importPrivateKey(d: Uint8Array, publicRaw: Uint8Array, use: "ECDH" | "ECDSA"): Promise<CryptoKey> {
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: b64url.encode(publicRaw.slice(1, 33)),
    y: b64url.encode(publicRaw.slice(33, 65)),
    d: b64url.encode(d),
  };
  return crypto.subtle.importKey("jwk", jwk, { name: use, namedCurve: "P-256" }, false, [use === "ECDH" ? "deriveBits" : "sign"]);
}

export interface Ephemeral {
  privateKey: CryptoKey;
  publicRaw: Uint8Array;
  salt: Uint8Array;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

const concat = (...parts: Uint8Array[]): Uint8Array => Uint8Array.from(parts.flatMap((p) => [...p]));

/** RFC 8291 section 3.4: the content encryption key and nonce for one message. */
export async function deriveKeys(
  ecdhSecret: Uint8Array,
  auth: Uint8Array,
  uaPublic: Uint8Array,
  asPublic: Uint8Array,
  salt: Uint8Array,
): Promise<{ cek: Uint8Array; nonce: Uint8Array }> {
  const ikm = await hkdf(auth, ecdhSecret, concat(text.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  return {
    cek: await hkdf(salt, ikm, text.encode("Content-Encoding: aes128gcm\0"), 16),
    nonce: await hkdf(salt, ikm, text.encode("Content-Encoding: nonce\0"), 12),
  };
}

async function newEphemeral(): Promise<Ephemeral> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  return {
    privateKey: pair.privateKey,
    publicRaw: new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer),
    salt: crypto.getRandomValues(new Uint8Array(16)),
  };
}

/** Encrypts one push message (single record) for the browser's `p256dh` public key and `auth` secret. */
export async function encryptPayload(
  plaintext: Uint8Array,
  p256dh: Uint8Array,
  auth: Uint8Array,
  ephemeral?: Ephemeral,
): Promise<Uint8Array> {
  const { privateKey, publicRaw, salt } = ephemeral ?? (await newEphemeral());
  const uaKey = await crypto.subtle.importKey("raw", p256dh, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // `public` is the standard member; the generated Workers types only declare it as `$public`.
  const algorithm = { name: "ECDH", public: uaKey } as SubtleCryptoDeriveKeyAlgorithm;
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits(algorithm, privateKey, 256));
  const { cek, nonce } = await deriveKeys(ecdh, auth, p256dh, publicRaw, salt);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const record = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, Uint8Array.of(2))));
  // Header: salt, record size 4096 (uint32 BE), key id length, key id (our public key).
  return concat(salt, Uint8Array.of(0, 0, 0x10, 0, publicRaw.length), publicRaw, record);
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** RFC 8292 `Authorization` header value: an ES256 JWT for the endpoint's origin, valid 12 hours. */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, nowMs = Date.now()): Promise<string> {
  const part = (value: object) => b64url.encode(text.encode(JSON.stringify(value)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(nowMs / 1000) + 43200,
    sub: keys.subject,
  })}`;
  const key = await importPrivateKey(b64url.decode(keys.privateKey), b64url.decode(keys.publicKey), "ECDSA");
  // WebCrypto already returns the 64-byte r||s that JOSE expects.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, text.encode(unsigned));
  return `vapid t=${unsigned}.${b64url.encode(new Uint8Array(signature))}, k=${keys.publicKey}`;
}

/** The VAPID settings, or null while any of the three is empty (push is off). */
export function vapidKeys(env: Env): VapidKeys | null {
  // VAPID_PRIVATE_KEY is an optional secret, so it is not in the generated Env type.
  const privateKey = (env as unknown as Record<string, string | undefined>).VAPID_PRIVATE_KEY;
  if (!env.VAPID_PUBLIC_KEY || !privateKey || !env.VAPID_SUBJECT) return null;
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey, subject: env.VAPID_SUBJECT };
}

export const pushConfigured = (env: Env): boolean => vapidKeys(env) !== null;
