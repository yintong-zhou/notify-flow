---
layout: home
hero:
  name: notify-flow
  tagline: Self-hosted transactional email over plain SMTP, plus opt-in Web Push, for Cloudflare Workers
  actions:
    - { theme: brand, text: Get started, link: /getting-started }
    - { theme: alt, text: API Reference, link: /api-reference }
    - { theme: alt, text: GitHub, link: https://github.com/yintong-zhou/notify-flow }
---

## Why notify-flow

<!--@include: ../README.md#why-->

## How it works

<!--@include: ../README.md#how-it-works-->

## Send your first email

```bash
curl -X POST "$NOTIFY_FLOW_URL/v1/email/send" \
  -H "Authorization: Bearer $NOTIFY_FLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: welcome:user-123" \
  -d '{ "template": "welcome", "to": "jane.doe@example.com",
        "variables": { "appName": "Acme", "name": "Jane" } }'
```

The response is `{"id":"msg_…","status":"submitted"}`: the SMTP server accepted the message.

## Notify a user's devices

Web Push is opt-in. Once the operator has enabled it for your client and the user's browser is registered, one call reaches every device of that user, even with your app closed:

```bash
curl -X POST "$NOTIFY_FLOW_URL/v1/push/send" \
  -H "Authorization: Bearer $NOTIFY_FLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: msg:42:9871" \
  -d '{ "user_id": "u_123", "template": "new-message", "tag": "chat-42", "url": "/chat/42",
        "variables": { "appName": "Acme", "sender": "Jane" } }'
```

The response is `{"id":"psh_…","status":"submitted","devices":2}`: two devices' push services accepted it. The user sees "You received a notification from Jane", never user-written text. The [Web Push guide](/web-app-integration-push) covers the browser, service worker and backend code.
