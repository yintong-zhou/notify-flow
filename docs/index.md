---
layout: home
hero:
  name: notify-flow
  tagline: Self-hosted transactional email for Cloudflare Workers, over plain SMTP
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
