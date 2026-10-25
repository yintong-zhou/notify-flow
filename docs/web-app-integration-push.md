# Integrating notify-flow — Web Push

Part of the [web app integration guide](web-app-integration.md). Contract: [Web Push API reference](api-reference-push.md).

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

async function enablePush() {
  if ((await Notification.requestPermission()) !== "granted") return;
  const { publicKey } = await (await fetch("/api/push/key")).json();
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: toKey(publicKey),
  });
  // Your backend calls PUT /v1/push/subscriptions with the logged-in user's id.
  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
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

## 2. On every app start

Safari can revoke a subscription, and changing the keys invalidates all of them. When permission is already granted, check the subscription at start-up and register again if needed. A repeated registration is harmless.

```js
async function ensureSubscribed() {
  if (Notification.permission !== "granted") return;
  const { publicKey } = await (await fetch("/api/push/key")).json();
  const registration = await navigator.serviceWorker.ready;
  const current = await registration.pushManager.getSubscription();
  const same = current && btoa(String.fromCharCode(...new Uint8Array(current.options.applicationServerKey)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === publicKey;
  if (same) return;
  await current?.unsubscribe();
  await enablePush();
}
```

## 3. On logout

The backend deletes the device, then the page drops the browser's subscription:

```js
// backend, with the endpoint sent by the page
await fetch(`${process.env.NOTIFY_FLOW_URL}/v1/push/subscriptions`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${process.env.NOTIFY_FLOW_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ endpoint }),
});

// page
const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
await subscription?.unsubscribe();
```

On account deletion send `{"user_id": "…"}` instead, to remove every device. This call works even when push is switched off.

## 4. The service worker

`push` must **always** call `showNotification`, even when your chat is on screen (see the next section for how the backend avoids that case).

```js
// sw.js
self.addEventListener("push", (event) => {
  const { title, body, url, tag } = event.data.json();
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
