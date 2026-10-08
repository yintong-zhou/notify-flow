export const LOCALES = ["it", "en", "pt-BR"] as const;
export type Locale = (typeof LOCALES)[number];
export const isLocale = (value: unknown): value is Locale => (LOCALES as readonly unknown[]).includes(value);

export type DeliveryStatus = "accepted" | "queued" | "processing" | "submitted" | "failed" | "retrying";

export interface Template {
  subject: string;
  html: string;
  text: string;
  variables: string[];
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;

  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
