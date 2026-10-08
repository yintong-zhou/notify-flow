import { describe, expect, it } from "vitest";
import { resolveSmtpConfig, type SmtpConfig } from "../src/smtp/provider";
import { base64, buildMessage, dotStuff, sendMail, type MailMessage } from "../src/smtp/smtp-client";
import { fakeSmtp } from "./fake-smtp";

const config: SmtpConfig = {
  provider: "gmail",
  host: "smtp.test",
  port: 465,
  security: "tls",
  authType: "plain",
  username: "user@example.com",
  password: "secret",
  from: "noreply@example.com",
  fromName: "Notify Flow",
};

const message: MailMessage = {
  from: "noreply@example.com",
  fromName: "Notify Flow",
  to: "user@example.com",
  messageId: "msg_1@example.com",
  subject: "Hello",
  html: "<p>Hi</p>",
  text: "Hi",
};

describe("sendMail", () => {
  it("runs a TLS session in order", async () => {
    const smtp = fakeSmtp();
    await sendMail(config, message, smtp.connect);
    expect(smtp.connections).toEqual([
      { address: { hostname: "smtp.test", port: 465 }, options: { secureTransport: "on", allowHalfOpen: false } },
    ]);
    expect(smtp.commands).toEqual([
      "EHLO example.com",
      `AUTH PLAIN ${base64("\0user@example.com\0secret")}`,
      "MAIL FROM:<noreply@example.com>",
      "RCPT TO:<user@example.com>",
      "DATA",
      "QUIT",
    ]);
    expect(smtp.upgraded).toBe(false);
    expect(smtp.data).toContain(`Subject: =?UTF-8?B?${base64("Hello")}?=`);
    expect(smtp.data).toContain(base64("<p>Hi</p>"));
    expect(smtp.data).toContain(base64("Hi"));
  });

  it("upgrades with STARTTLS and repeats EHLO", async () => {
    const smtp = fakeSmtp();
    await sendMail({ ...config, port: 587, security: "starttls" }, message, smtp.connect);
    expect(smtp.connections[0].options).toEqual({ secureTransport: "starttls", allowHalfOpen: false });
    expect(smtp.upgraded).toBe(true);
    expect(smtp.commands.slice(0, 3)).toEqual(["EHLO example.com", "STARTTLS", "EHLO example.com"]);
  });

  it("authenticates with AUTH LOGIN", async () => {
    const smtp = fakeSmtp();
    await sendMail({ ...config, authType: "login" }, message, smtp.connect);
    expect(smtp.commands.slice(1, 4)).toEqual(["AUTH LOGIN", base64("user@example.com"), base64("secret")]);
  });

  it("classifies 4xx as transient", async () => {
    const smtp = fakeSmtp({ RCPT: "451 try later" });
    await expect(sendMail(config, message, smtp.connect)).rejects.toMatchObject({
      code: "smtp_temporary_failure",
      transient: true,
    });
  });

  it("classifies a 5xx AUTH reply as a permanent auth failure", async () => {
    const smtp = fakeSmtp({ AUTH: "535 bad credentials" });
    await expect(sendMail(config, message, smtp.connect)).rejects.toMatchObject({ code: "smtp_auth_failed", transient: false });
  });

  it("classifies other 5xx replies as rejected", async () => {
    const smtp = fakeSmtp({ RCPT: "550 no such user" });
    await expect(sendMail(config, message, smtp.connect)).rejects.toMatchObject({ code: "smtp_rejected", transient: false });
  });

  it("times out when the server stops answering", async () => {
    const smtp = fakeSmtp({ MAIL: "SILENT" });
    await expect(sendMail(config, message, smtp.connect, 50)).rejects.toMatchObject({ code: "smtp_timeout", transient: true });
  });

  it("never puts the SMTP reply text in the error message", async () => {
    const smtp = fakeSmtp({ RCPT: "550 user@example.com does not exist" });
    await expect(sendMail(config, message, smtp.connect)).rejects.toThrow(/^SMTP 550$/);
  });
});

describe("buildMessage", () => {
  it("dot-stuffs lines starting with a dot", () => {
    expect(dotStuff("a\r\n.b\r\n..c")).toBe("a\r\n..b\r\n...c");
  });

  it("folds a long non-ASCII subject into valid encoded words", () => {
    const subject = "è".repeat(255);
    const raw = buildMessage({ ...message, subject });
    for (const line of raw.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
    const header = raw.slice(raw.indexOf("Subject: "), raw.indexOf("\r\nDate: "));
    const words = [...header.matchAll(/=\?UTF-8\?B\?([^?]*)\?=/g)].map((m) => m[0]);
    for (const word of words) expect(word.length).toBeLessThanOrEqual(75);
    const decoded = words
      .map((w) => new TextDecoder().decode(Uint8Array.from(atob(w.slice(10, -2)), (c) => c.charCodeAt(0))))
      .join("");
    expect(decoded).toBe(subject);
  });

  it("uses CRLF in the text body", () => {
    const raw = buildMessage({ ...message, text: "a\nb" });
    expect(raw).toContain(base64("a\r\nb"));
  });
});

describe("resolveSmtpConfig", () => {
  const env = {
    SMTP_PROVIDER: "gmail",
    SMTP_HOST: "",
    SMTP_PORT: "",
    SMTP_SECURITY: "",
    SMTP_AUTH_TYPE: "plain",
    SMTP_USERNAME: "u",
    SMTP_PASSWORD: "p",
    SMTP_FROM_EMAIL: "a@example.com",
    SMTP_FROM_NAME: "N",
  } as unknown as Env;

  it("applies the provider preset", () => {
    expect(resolveSmtpConfig(env)).toMatchObject({ provider: "gmail", host: "smtp.gmail.com", port: 465, security: "tls" });
    expect(resolveSmtpConfig({ ...env, SMTP_PROVIDER: "microsoft" })).toMatchObject({
      host: "smtp.office365.com",
      port: 587,
      security: "starttls",
    });
  });

  it("defaults the auth type per preset (Microsoft 365 only offers AUTH LOGIN)", () => {
    const noAuth = { ...env, SMTP_AUTH_TYPE: "" };
    expect(resolveSmtpConfig({ ...noAuth, SMTP_PROVIDER: "microsoft" }).authType).toBe("login");
    expect(resolveSmtpConfig(noAuth).authType).toBe("plain");
    expect(resolveSmtpConfig({ ...env, SMTP_PROVIDER: "microsoft", SMTP_AUTH_TYPE: "plain" }).authType).toBe("plain");
  });

  it("lets vars override the preset", () => {
    expect(resolveSmtpConfig({ ...env, SMTP_PORT: "587", SMTP_SECURITY: "starttls" })).toMatchObject({
      host: "smtp.gmail.com",
      port: 587,
      security: "starttls",
    });
  });

  it("rejects generic without a host, port 25 and unknown providers", () => {
    expect(() => resolveSmtpConfig({ ...env, SMTP_PROVIDER: "generic" })).toThrow("SMTP is not configured correctly");
    expect(() => resolveSmtpConfig({ ...env, SMTP_PORT: "25" })).toThrow("SMTP is not configured correctly");
    expect(() => resolveSmtpConfig({ ...env, SMTP_PROVIDER: "sendgrid" })).toThrow("SMTP is not configured correctly");
  });
});
