# Getting started

notify-flow runs in your own Cloudflare account: one Worker, one D1 database and one queue.

::: warning Your own instance, not a shared service
There is no public notify-flow you can sign up for. Each person or team deploys their own copy, with their own Cloudflare account and SMTP mailbox, and connects their own apps to it. The author's deployment is private: don't point your apps at it. To be guided through the deploy and the integration into your site, paste the [AI integration prompt](ai-integration-prompt.md) (or the [AI Web Push prompt](ai-push-integration-prompt.md)) into a coding agent.
:::

<!--@include: ../README.md#getting-started-->

## SMTP configuration

<!--@include: ../README.md#smtp-configuration-->

## Security

<!--@include: ../README.md#security-->

## Next

Wire your app to it with the [integration guide](web-app-integration.md), or look up an endpoint in the [API Reference](api-reference.md). To monitor deliveries and errors, set up the [admin dashboard](admin-dashboard.md).
