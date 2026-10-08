# Cloudflare Email Notification Service — Statuses, queues and project structure

Part of the requirements in [notification-service.md](../../notification-service.md).

## Statuses

The recommended statuses are:

```text
accepted
queued
processing
submitted
failed
retrying
```

A positive response from the SMTP server means the message has been accepted by the SMTP server, not necessarily delivered to the recipient's inbox. For this reason, it is preferable to use `submitted` instead of `delivered` until a true delivery tracking system is implemented.

---

## Cloudflare Queues

After the first MVP, sending should become asynchronous.

```text
Backend
   |
   | REST request
   v
API Worker
   |
   | validation
   | authentication
   | enqueue
   v
Cloudflare Queue
   |
   v
Email Worker
   |
   | template rendering
   | SMTP
   | retry
   | logging
   v
SMTP Provider
```

The REST API can thus respond quickly with `202 Accepted` and a `queued` status.

---

## Initial project structure

```text
project-root/
|
├── src/
│   ├── index.ts
│   ├── routes/
│   │   ├── email.ts
│   │   └── health.ts
│   ├── smtp/
│   │   ├── smtp-client.ts
│   │   ├── provider.ts
│   │   ├── gmail.ts
│   │   ├── microsoft.ts
│   │   └── generic.ts
│   ├── templates/
│   │   ├── renderer.ts
│   │   ├── welcome.ts
│   │   ├── verify-email.ts
│   │   ├── password-reset.ts
│   │   └── login-alert.ts
│   ├── security/
│   │   ├── auth.ts
│   │   ├── validation.ts
│   │   └── rate-limit.ts
│   ├── services/
│   │   └── email-service.ts
│   └── types/
│       └── index.ts
├── wrangler.jsonc
├── package.json
└── tsconfig.json
```