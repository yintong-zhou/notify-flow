# Cloudflare Email Notification Service — Templates and SMTP

Part of the requirements in [notification-service.md](../../notification-service.md).

## Email templates

The service should use predefined templates instead of allowing the frontend to send arbitrary HTML.

Initial examples:

```text
welcome
verify-email
password-reset
password-changed
login-alert
generic-notification
```

Each template may contain:

```text
subject
html
text
allowed variables
locale
```

This keeps branding, copy, translations, layout, security, and versioning centralized.

---

## SMTP support

The system must be designed as a generic SMTP client and not be tied exclusively to Gmail.

Conceptual configuration:

```text
SMTP_HOST
SMTP_PORT
SMTP_SECURITY
SMTP_AUTH_TYPE
SMTP_USERNAME
SMTP_PASSWORD
SMTP_FROM_EMAIL
SMTP_FROM_NAME
```

### Gmail / Google Workspace

```text
host: smtp.gmail.com
port: 465
security: tls
```

or:

```text
host: smtp.gmail.com
port: 587
security: starttls
```

### Microsoft 365

```text
host: smtp.office365.com
port: 587
security: starttls
```

### Generic SMTP

```text
host: smtp.example.com
port: 587
security: starttls
username: ...
password: ...
```

---

## Provider abstraction

The application logic must not depend directly on Gmail or Microsoft.

```text
Email Service
     |
     v
SMTP Adapter
     |
     +--> Gmail preset
     +--> Microsoft preset
     +--> Generic SMTP
```

Gmail and Microsoft can therefore be treated as configuration presets on top of a generic SMTP client.

---

## SMTP Client

The SMTP client must handle at least:

```text
TCP connection
EHLO
STARTTLS
AUTH LOGIN
AUTH PLAIN
MAIL FROM
RCPT TO
DATA
QUIT
```

It must also support:

```text
Implicit TLS
STARTTLS
```

In the future, the following may be added:

```text
OAuth2 / XOAUTH2
```

for providers such as Microsoft 365 and Google Workspace.
