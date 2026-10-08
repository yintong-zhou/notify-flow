import { HttpError } from "../types";

export type Security = "tls" | "starttls";
export type AuthType = "plain" | "login";

export interface SmtpConfig {
  provider: string;
  host: string;
  port: number;
  security: Security;
  authType: AuthType;
  username: string;
  password: string;
  from: string;
  fromName: string;
}

const PRESETS: Record<string, { host: string; port: number; security: Security }> = {
  gmail: { host: "smtp.gmail.com", port: 465, security: "tls" },
  microsoft: { host: "smtp.office365.com", port: 587, security: "starttls" },
  generic: { host: "", port: 587, security: "starttls" },
};

export function resolveSmtpConfig(env: Env): SmtpConfig {
  const provider = env.SMTP_PROVIDER;
  const preset = Object.hasOwn(PRESETS, provider) ? PRESETS[provider] : undefined;
  const host = env.SMTP_HOST || preset?.host;
  const port = Number(env.SMTP_PORT || preset?.port);
  const security = env.SMTP_SECURITY || preset?.security;
  const authType = env.SMTP_AUTH_TYPE;
  if (
    !preset ||
    !host ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    port === 25 || // outbound port 25 is blocked on Workers
    (security !== "tls" && security !== "starttls") ||
    (authType !== "plain" && authType !== "login") ||
    !env.SMTP_USERNAME ||
    !env.SMTP_PASSWORD ||
    !env.SMTP_FROM_EMAIL
  ) {
    throw new HttpError(500, "smtp_misconfigured", "SMTP is not configured correctly");
  }
  return {
    provider,
    host,
    port,
    security,
    authType,
    username: env.SMTP_USERNAME,
    password: env.SMTP_PASSWORD,
    from: env.SMTP_FROM_EMAIL,
    fromName: env.SMTP_FROM_NAME,
  };
}
