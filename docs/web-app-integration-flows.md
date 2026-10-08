# Integrating notify-flow into a web app: flows and production

Part 2 of the [web app integration guide](web-app-integration.md): common flows, custom templates, retries, security and the production checklist.

## Common flows

Each event in your web app maps to a built-in template. The backend generates links and tokens before calling notify-flow.

| Web app event | Template | Required variables | Suggested `Idempotency-Key` |
| --- | --- | --- | --- |
| Sign-up completed | `welcome` | `appName`, `name` | `welcome:<userId>` |
| Email address verification | `verify-email` | `appName`, `name`, `verifyUrl` | `verify:<userId>:<tokenId>` |
| Password reset request | `password-reset` | `appName`, `name`, `resetUrl` | `reset:<userId>:<tokenId>` |
| Password changed | `password-changed` | `appName`, `name` | `pwchanged:<userId>:<timestamp>` |
| Sign-in from a new device | `login-alert` | `appName`, `name`, `device`, `ipAddress`, `time` | `login:<sessionId>` |
| Generic notice | `generic-notification` | `appName`, `title`, `message` | `notice:<eventId>` |

A password reset in an Express backend:

```typescript
app.post("/forgot-password", async (req, res) => {
  const user = await db.users.findByEmail(req.body.email);
  if (user) {
    const token = await createResetToken(user.id);   // stored with an expiry, e.g. 30 minutes
    await sendEmail({
      template: "password-reset",
      to: user.email,
      locale: user.locale,
      variables: { name: user.firstName, resetUrl: `https://app.acme.com/reset?token=${token.value}` },
      idempotencyKey: `reset:${user.id}:${token.id}`,
    }).catch((err) => log.error("reset email failed", { userId: user.id, err: err.message }));
  }
  // Same answer whether or not the user exists: don't reveal which emails are registered.
  res.json({ message: "If the address is registered, you'll receive an email." });
});
```

Four rules apply to every flow:

- **Tokens:** generate and check tokens in your backend. notify-flow only receives the finished link.
- **Variables:** always send `appName`: every built-in template uses it in the footer.
- **Locale:** use the user's language (`it`, `en`, `pt-BR`). If you don't know it, `en` is used.
- **Time:** format `time` in the user's time zone and language before sending it, e.g. `Oct 8, 2026, 2:32 PM`.

## Custom templates

Each web app can register its own templates, or override built-in ones, one locale at a time. An app's templates are invisible to the other apps.

```bash
curl -X PUT "$NOTIFY_FLOW_URL/v1/templates/order-shipped/en" \
  -H "Authorization: Bearer $NOTIFY_FLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "subject": "Your order {{orderId}} is on its way",
    "html": "<p>Hi {{name}},</p><p>we shipped order {{orderId}}. <a href=\"{{trackingUrl}}\">Track your parcel</a>.</p>",
    "text": "Hi {{name}},\nwe shipped order {{orderId}}: {{trackingUrl}}",
    "variables": ["name", "orderId", "trackingUrl"]
  }'
```

| Method and path | What it does |
| --- | --- |
| `GET /v1/templates` | Lists your templates and the built-in ones (marked `builtin: true`) |
| `GET /v1/templates/:name/:locale` | Returns a template: yours if it exists, otherwise the built-in one |
| `PUT /v1/templates/:name/:locale` | Creates or updates a template |
| `DELETE /v1/templates/:name/:locale` | Deletes one of your templates. Built-in ones can't be deleted |

Writing templates:

- **Placeholders:** written as `{{variableName}}`, and each one must appear in the `variables` list, otherwise the `PUT` returns `400`.
- **Safe values:** in `html`, values are always escaped, so a name like `<script>` is never executed. In the subject, line breaks are removed.
- **Limits:** subject up to 255 characters on one line, `html` up to 100 KB, `text` up to 50 KB.
- **Lookup order when sending:** your template in the requested locale, then the built-in one in that locale, then the same lookup in `en`. You can therefore override a single built-in template in a single locale.
- **Fixed copy:** keep every unchanging word in the template, and use variables only for per-send data. Content passed in from outside raises the abuse risk if the key is ever stolen.

## Errors, retries and idempotency

Retry only with the same `Idempotency-Key`: that way a retry never produces a second email. notify-flow already makes up to 3 SMTP attempts before it answers.

| Outcome | Retry? | How |
| --- | --- | --- |
| Timeout or network error reaching notify-flow | yes | Same `Idempotency-Key`, after a few seconds |
| `429 rate_limited` | yes, later | After at least a minute. The per-recipient limit spans one hour |
| `500` | yes, later | Same key. If it keeps happening, tell the administrator |
| `502 smtp_failed` | only if the user asks | With a **new** key: the old one returns `failed` again |
| `400`, `401`, `404`, `413` | no | Integration error: fix the code or the configuration |

How idempotency works:

- **Same key:** the same `Idempotency-Key` from the same app always returns the first result (`id` and `status`) without sending again, even once the per-recipient limit is reached.
- **One key per action:** the key identifies the user's action, not the HTTP call. Two reset requests made by the user are two actions: two keys.
- **No key:** every call sends an email.
- **Interrupted send:** if a request stays in `processing` for more than 5 minutes, a replay with the same key closes it as `failed`. In that case the email may have gone out anyway.

Rate limits:

- **Per app:** 60 requests per minute across all `/v1/*` routes.
- **Per recipient:** 5 emails per hour to the same recipient with the same template, within your app. Failed sends don't count. The administrator can change this value.

A failed send must not block the user's request: log the error and show the neutral message your flow uses.

## Security and good practice

The API key lets whoever holds it send email in the service's name, so protect it like a password.

- **Backend only:** the frontend never calls notify-flow. It calls an endpoint of your app (`/forgot-password`, `/register`), which decides whether a send is legitimate.
- **No send-on-demand:** don't expose endpoints like "send this email to this address". Every send comes from an action your backend has checked.
- **Limits in your app too:** limit reset and sign-up attempts per IP and per account. notify-flow's limits are the last line of defence, not the first.
- **Short-lived, single-use tokens:** verification and reset links must expire (e.g. 30 minutes for a reset) and work only once.
- **Clean logs:** never log the variables you send, especially `resetUrl` and `verifyUrl`, or the API key. The `id` returned by notify-flow is enough.
- **Neutral answers:** for password reset and sign-up, always answer the same way whether or not the email exists.
- **Rotation:** if the key may have been exposed, have it replaced at once. Each app has its own key, so the others are unaffected.
- **Sender:** the sender address is the one configured in notify-flow. With Gmail it must match the sending account, or Gmail rewrites it.

## Production checklist

- [ ] An API key dedicated to the app, stored as a backend secret
- [ ] `NOTIFY_FLOW_URL` and `NOTIFY_FLOW_API_KEY` set in every environment (development, staging, production)
- [ ] No calls to notify-flow from the frontend
- [ ] An `Idempotency-Key` on every send, unique per user action
- [ ] An HTTP client timeout of at least 30 seconds
- [ ] `400`, `401` and `404` errors logged as integration bugs
- [ ] `429`, `500` and network errors retried with the same key
- [ ] Neutral answers for password reset and sign-up
- [ ] Single-use, expiring verification and reset tokens
- [ ] Only the delivery `id` in logs, never variables or links
- [ ] Custom templates created and tested in every locale you use
- [ ] One test send per template to an internal inbox, checking the spam folder too
