export interface Subscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

const MAX_PER_USER = 10;

/** Registers or moves a device. The same endpoint under another client is a separate row. Keeps the user's 10 newest. */
export async function upsertSubscription(db: D1Database, clientId: string, userId: string, sub: Subscription): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO push_subscriptions (client_id, endpoint, user_id, p256dh, auth, created_at)
         VALUES (?, ?, ?, ?, ?, unixepoch())
         ON CONFLICT (client_id, endpoint) DO UPDATE SET
           user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`,
      )
      .bind(clientId, sub.endpoint, userId, sub.p256dh, sub.auth),
    db
      .prepare(
        `DELETE FROM push_subscriptions WHERE client_id = ? AND user_id = ? AND rowid NOT IN (
           SELECT rowid FROM push_subscriptions WHERE client_id = ? AND user_id = ?
           ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
      )
      .bind(clientId, userId, clientId, userId, MAX_PER_USER),
  ]);
}

export async function removeSubscriptions(db: D1Database, clientId: string, target: { endpoint: string } | { userId: string }): Promise<void> {
  const [column, value] = "endpoint" in target ? ["endpoint", target.endpoint] : ["user_id", target.userId];
  await db.prepare(`DELETE FROM push_subscriptions WHERE client_id = ? AND ${column} = ?`).bind(clientId, value).run();
}

export async function listSubscriptions(db: D1Database, clientId: string, userId: string): Promise<Subscription[]> {
  const { results } = await db
    .prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE client_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC")
    .bind(clientId, userId)
    .all<Subscription>();
  return results;
}

/** Drops one device, used when its push service answers 404 or 410. */
export async function deleteSubscription(db: D1Database, clientId: string, endpoint: string): Promise<void> {
  await removeSubscriptions(db, clientId, { endpoint });
}
