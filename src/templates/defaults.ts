import type { Locale, Template } from "../types";

const layout = (body: string): string =>
  `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:Arial,Helvetica,sans-serif;color:#1f2933;line-height:1.5">` +
  `<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px">${body}</div>` +
  `<p style="max-width:560px;margin:16px auto 0;font-size:12px;color:#7b8794;text-align:center">{{appName}}</p>` +
  `</body></html>`;

const button = (url: string, label: string): string =>
  `<p style="margin:24px 0"><a href="${url}" style="display:inline-block;padding:12px 20px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px">${label}</a></p>`;

const tpl = (variables: string[], subject: string, html: string, text: string): Template => ({
  variables,
  subject,
  html: layout(html),
  text,
});

const WELCOME = ["appName", "name"];
const VERIFY = ["appName", "name", "verifyUrl"];
const RESET = ["appName", "name", "resetUrl"];
const CHANGED = ["appName", "name"];
const LOGIN = ["appName", "name", "device", "ipAddress", "time"];
const GENERIC = ["appName", "title", "message"];

const generic = tpl(GENERIC, "{{title}}", "<h1>{{title}}</h1><p>{{message}}</p>", "{{title}}\n\n{{message}}");

const DEFAULTS: Record<string, Record<Locale, Template>> = {
  welcome: {
    en: tpl(WELCOME, "Welcome to {{appName}}",
      "<h1>Welcome, {{name}}!</h1><p>Your {{appName}} account is ready.</p>",
      "Welcome, {{name}}!\n\nYour {{appName}} account is ready."),
    it: tpl(WELCOME, "Benvenuto su {{appName}}",
      "<h1>Benvenuto, {{name}}!</h1><p>Il tuo account {{appName}} è pronto.</p>",
      "Benvenuto, {{name}}!\n\nIl tuo account {{appName}} è pronto."),
    "pt-BR": tpl(WELCOME, "Boas-vindas ao {{appName}}",
      "<h1>Olá, {{name}}!</h1><p>Sua conta no {{appName}} está pronta.</p>",
      "Olá, {{name}}!\n\nSua conta no {{appName}} está pronta."),
  },
  "verify-email": {
    en: tpl(VERIFY, "Verify your email for {{appName}}",
      `<p>Hi {{name}},</p><p>Confirm your email address to finish setting up your {{appName}} account.</p>${button("{{verifyUrl}}", "Verify email")}<p>If you didn't create an account, you can ignore this email.</p>`,
      "Hi {{name}},\n\nConfirm your email address to finish setting up your {{appName}} account:\n{{verifyUrl}}\n\nIf you didn't create an account, you can ignore this email."),
    it: tpl(VERIFY, "Conferma la tua email per {{appName}}",
      `<p>Ciao {{name}},</p><p>Conferma il tuo indirizzo email per completare la registrazione su {{appName}}.</p>${button("{{verifyUrl}}", "Conferma email")}<p>Se non hai creato un account, ignora questa email.</p>`,
      "Ciao {{name}},\n\nConferma il tuo indirizzo email per completare la registrazione su {{appName}}:\n{{verifyUrl}}\n\nSe non hai creato un account, ignora questa email."),
    "pt-BR": tpl(VERIFY, "Confirme seu e-mail no {{appName}}",
      `<p>Olá, {{name}},</p><p>Confirme seu endereço de e-mail para concluir o cadastro no {{appName}}.</p>${button("{{verifyUrl}}", "Confirmar e-mail")}<p>Se você não criou uma conta, ignore este e-mail.</p>`,
      "Olá, {{name}},\n\nConfirme seu endereço de e-mail para concluir o cadastro no {{appName}}:\n{{verifyUrl}}\n\nSe você não criou uma conta, ignore este e-mail."),
  },
  "password-reset": {
    en: tpl(RESET, "Reset your {{appName}} password",
      `<p>Hi {{name}},</p><p>We received a request to reset your password.</p>${button("{{resetUrl}}", "Reset password")}<p>If you didn't ask for this, ignore this email: your password won't change.</p>`,
      "Hi {{name}},\n\nWe received a request to reset your password:\n{{resetUrl}}\n\nIf you didn't ask for this, ignore this email: your password won't change."),
    it: tpl(RESET, "Reimposta la password di {{appName}}",
      `<p>Ciao {{name}},</p><p>Abbiamo ricevuto una richiesta di reimpostazione della password.</p>${button("{{resetUrl}}", "Reimposta password")}<p>Se non sei stato tu, ignora questa email: la tua password non cambierà.</p>`,
      "Ciao {{name}},\n\nAbbiamo ricevuto una richiesta di reimpostazione della password:\n{{resetUrl}}\n\nSe non sei stato tu, ignora questa email: la tua password non cambierà."),
    "pt-BR": tpl(RESET, "Redefina sua senha do {{appName}}",
      `<p>Olá, {{name}},</p><p>Recebemos uma solicitação para redefinir sua senha.</p>${button("{{resetUrl}}", "Redefinir senha")}<p>Se não foi você, ignore este e-mail: sua senha não será alterada.</p>`,
      "Olá, {{name}},\n\nRecebemos uma solicitação para redefinir sua senha:\n{{resetUrl}}\n\nSe não foi você, ignore este e-mail: sua senha não será alterada."),
  },
  "password-changed": {
    en: tpl(CHANGED, "Your {{appName}} password was changed",
      "<p>Hi {{name}},</p><p>Your {{appName}} password was just changed.</p><p>If you didn't do this, reset your password right away and contact support.</p>",
      "Hi {{name}},\n\nYour {{appName}} password was just changed.\n\nIf you didn't do this, reset your password right away and contact support."),
    it: tpl(CHANGED, "La password di {{appName}} è stata modificata",
      "<p>Ciao {{name}},</p><p>La password del tuo account {{appName}} è appena stata modificata.</p><p>Se non sei stato tu, reimposta subito la password e contatta l'assistenza.</p>",
      "Ciao {{name}},\n\nLa password del tuo account {{appName}} è appena stata modificata.\n\nSe non sei stato tu, reimposta subito la password e contatta l'assistenza."),
    "pt-BR": tpl(CHANGED, "Sua senha do {{appName}} foi alterada",
      "<p>Olá, {{name}},</p><p>A senha da sua conta no {{appName}} acabou de ser alterada.</p><p>Se não foi você, redefina sua senha imediatamente e entre em contato com o suporte.</p>",
      "Olá, {{name}},\n\nA senha da sua conta no {{appName}} acabou de ser alterada.\n\nSe não foi você, redefina sua senha imediatamente e entre em contato com o suporte."),
  },
  "login-alert": {
    en: tpl(LOGIN, "New sign-in to your {{appName}} account",
      "<p>Hi {{name}},</p><p>We noticed a new sign-in to your account:</p><ul><li>Device: {{device}}</li><li>IP address: {{ipAddress}}</li><li>Time: {{time}}</li></ul><p>If this wasn't you, change your password right away.</p>",
      "Hi {{name}},\n\nWe noticed a new sign-in to your account:\n- Device: {{device}}\n- IP address: {{ipAddress}}\n- Time: {{time}}\n\nIf this wasn't you, change your password right away."),
    it: tpl(LOGIN, "Nuovo accesso al tuo account {{appName}}",
      "<p>Ciao {{name}},</p><p>Abbiamo rilevato un nuovo accesso al tuo account:</p><ul><li>Dispositivo: {{device}}</li><li>Indirizzo IP: {{ipAddress}}</li><li>Data e ora: {{time}}</li></ul><p>Se non sei stato tu, cambia subito la password.</p>",
      "Ciao {{name}},\n\nAbbiamo rilevato un nuovo accesso al tuo account:\n- Dispositivo: {{device}}\n- Indirizzo IP: {{ipAddress}}\n- Data e ora: {{time}}\n\nSe non sei stato tu, cambia subito la password."),
    "pt-BR": tpl(LOGIN, "Novo acesso à sua conta do {{appName}}",
      "<p>Olá, {{name}},</p><p>Detectamos um novo acesso à sua conta:</p><ul><li>Dispositivo: {{device}}</li><li>Endereço IP: {{ipAddress}}</li><li>Data e hora: {{time}}</li></ul><p>Se não foi você, altere sua senha imediatamente.</p>",
      "Olá, {{name}},\n\nDetectamos um novo acesso à sua conta:\n- Dispositivo: {{device}}\n- Endereço IP: {{ipAddress}}\n- Data e hora: {{time}}\n\nSe não foi você, altere sua senha imediatamente."),
  },
  "generic-notification": { en: generic, it: generic, "pt-BR": generic },
};

export function builtinTemplate(name: string, locale: Locale): Template | undefined {
  // hasOwn: names like "constructor" are valid template names but must not hit Object.prototype.
  return Object.hasOwn(DEFAULTS, name) ? DEFAULTS[name][locale] : undefined;
}

export function listBuiltins(): { name: string; locale: Locale }[] {
  return Object.entries(DEFAULTS).flatMap(([name, locales]) =>
    (Object.keys(locales) as Locale[]).map((locale) => ({ name, locale })),
  );
}
