# Integrating notify-flow — Web Push

Part of the [web app integration guide](web-app-integration.md). Contract: [Web Push API reference](api-reference-push.md). To let a coding agent do it, paste the [AI Web Push prompt](ai-push-integration-prompt.md).

## When to use it

Push shows a notification on a user's phone or computer even when your app is closed, for example "You received a notification from Marco". It is opt-in: ask the notify-flow administrator to enable it for your client ([setup](admin-dashboard.md#web-push)).

A notification never carries user-written text. notify-flow renders a built-in template from a few short variables (the sender's name, the app name), so the user taps it and reads the message in your app.

Only the browser code below runs in your frontend. The frontend still never calls notify-flow: it talks to your own backend, which calls `/v1/push/*` with the API key.

## Requirements

- HTTPS, and a service worker served from your app's origin.
- **iPhone and iPad:** the app needs a web app manifest and the user must add it to the Home Screen first. Safari does not offer push in a normal tab.
- **Safari:** every push must end in a visible notification. A service worker that skips `showNotification` gets the subscription revoked.

## 1. Subscribe, after a click

Never ask for permission on page load. Do it from a button:

```js
// Your backend relays GET /v1/push/public-key on its own route: it answers {"publicKey": <public_key>}.
const toKey = (b64) => Uint8Array.from(atob(b64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

// Your backend calls PUT /v1/push/subscriptions with the logged-in user's id.
async function register(subscription) {
  const r = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!r.ok) throw new Error(`push registration failed (${r.status})`);
}

async function enablePush() {
  if ((await Notification.requestPermission()) !== "granted") return;
  const { publicKey } = await (await fetch("/api/push/key")).json();
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: toKey(publicKey),
  });
  await register(subscription);
}
```

The backend route adds `user_id` from the session, never from the request body:

```js
app.post("/api/push/subscribe", requireLogin, async (req, res) => {
  const r = await fetch(`${process.env.NOTIFY_FLOW_URL}/v1/push/subscriptions`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${process.env.NOTIFY_FLOW_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: req.user.id, subscription: req.body }),
  });
  res.sendStatus(r.status);
});
```

## 2. On app start and after login

Safari can revoke a subscription, and changing the keys invalidates all of them. When permission is already granted, check the subscription and register it again. Call this **only with a logged-in session**: on app start, and right after login (the backend answers `401` otherwise, and nothing would be registered). A current subscription is still sent to your backend: the upsert moves the endpoint to the logged-in user, so a device shared by two accounts always notifies the one who is signed in. A repeated registration is harmless.

```js
async function ensureSubscribed() {
  if (Notification.permission !== "granted") return;
  const { publicKey } = await (await fetch("/api/push/key")).json();
  const registration = await navigator.serviceWorker.ready;
  const current = await registration.pushManager.getSubscription();
  const same = current && btoa(String.fromCharCode(...new Uint8Array(current.options.applicationServerKey)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === publicKey;
  if (same) return register(current);
  await current?.unsubscribe();
  await enablePush();
}
```

## 3. On logout

The page reads the endpoint, tells the backend, then drops the browser's subscription:

```js
// page
const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
const endpoint = subscription?.endpoint;
await subscription?.unsubscribe();
if (endpoint) await fetch("/api/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint }) });

// backend, with the endpoint sent by the page
await fetch(`${process.env.NOTIFY_FLOW_URL}/v1/push/subscriptions`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${process.env.NOTIFY_FLOW_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ endpoint }),
});
```

`DELETE` by endpoint is scoped per client, not per user: your backend should only delete an endpoint that the session user registered (keep a record), or send `{"user_id": "…"}` to remove all of that user's devices (also on account deletion). These calls work even when push is switched off.

## 4. The service worker

`push` must **always** call `showNotification`, even when your chat is on screen (see the next section for how the backend avoids that case).

```js
// sw.js
self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data.json();
  } catch {} // empty or non-JSON payload: still show something, or Safari revokes the subscription
  const { title = "New notification", body, url, tag } = message;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: !!tag,
      icon: "/icon-192.png",
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? "/", self.location.origin).href;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => w.url === target);
      return open ? open.focus() : clients.openWindow(target);
    }),
  );
});
```

Notifications with the same `tag` replace each other, so a busy conversation shows one entry, not twenty.

## 5. The backend: no push when the chat is open

When a message arrives, the backend decides how to deliver it. Your platform defines "open", for example a focused window reported over your realtime connection.

```text
onMessage(message, recipient):
  if recipient has this conversation open and focused on any device:
      deliver through the realtime channel only
  else:
      POST /v1/push/send
        user_id   = recipient.id
        template  = "new-message"
        variables = { appName, sender: message.sender.firstName }
        tag       = conversation.id
        url       = "/chat/" + conversation.id
        Idempotency-Key = "msg:" + message.id
```

Handle the answers like email: `404 no_subscriptions` means the user has no device (ignore it), `429` means drop the push (the earlier ones for that conversation are still on screen), and `502` or a network error is not worth blocking the message for.

## 6. Page cleanup

When a conversation opens, or shows a new message while focused, close its notifications. This removes the rare one that slipped through just as the chat opened:

```js
async function clearNotifications(conversationId) {
  const registration = await navigator.serviceWorker.ready;
  (await registration.getNotifications({ tag: conversationId })).forEach((n) => n.close());
}
```

## Changing the keys

Do not rotate the VAPID keys unless they were compromised. Every browser then has to subscribe again: the start-up check in step 2 does it the next time each user opens the app.
