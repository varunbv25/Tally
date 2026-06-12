/* Tally push backend — stores push subscriptions plus their
   client-projected notification schedules; a cron trigger delivers
   due entries via Web Push. The ledger itself never leaves the
   device: this worker only ever sees pre-rendered notification
   payloads ({fireAt, key, title, body}). */

import { buildPushPayload } from '@block65/webcrypto-web-push';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json', ...CORS },
  });

async function endpointKey(endpoint) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    try {
      if (url.pathname === '/subscribe' && req.method === 'POST') {
        const { subscription, schedule } = await req.json();
        if (!subscription?.endpoint || !Array.isArray(schedule)) return json({ error: 'bad request' }, 400);
        const key = await endpointKey(subscription.endpoint);
        const prev = await env.TALLY_PUSH.get(key, 'json');
        const cutoff = Date.now() - 30 * 86_400_000;
        await env.TALLY_PUSH.put(key, JSON.stringify({
          subscription, schedule,
          sentKeys: (prev?.sentKeys || []).filter(s => s.at > cutoff),
          lastNudge: prev?.lastNudge || 0,
        }));
        return json({ ok: true });
      }
      if (url.pathname === '/sync' && req.method === 'POST') {
        const { endpoint } = await req.json();
        const record = await env.TALLY_PUSH.get(await endpointKey(endpoint), 'json');
        if (!record) return json({ error: 'unknown subscription' }, 404);
        return json({ sentKeys: record.sentKeys.map(s => s.key), lastNudge: record.lastNudge });
      }
      if (url.pathname === '/subscribe' && req.method === 'DELETE') {
        const { endpoint } = await req.json();
        await env.TALLY_PUSH.delete(await endpointKey(endpoint));
        return json({ ok: true });
      }
      return json({ error: 'not found' }, 404);
    } catch {
      return json({ error: 'server error' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(deliverDue(env));
  },
};

async function deliverDue(env) {
  const vapid = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
  const now = Date.now();
  const list = await env.TALLY_PUSH.list();
  for (const { name } of list.keys) {
    try {
      const record = await env.TALLY_PUSH.get(name, 'json');
      if (!record) continue;
      const due = record.schedule.filter(e => e.fireAt <= now);
      if (!due.length) continue;
      let dead = false;
      for (const entry of due) {
        const payload = await buildPushPayload(
          { data: JSON.stringify(entry), options: { ttl: 12 * 3600 } },
          record.subscription, vapid,
        );
        const res = await fetch(record.subscription.endpoint, payload);
        if (res.status === 404 || res.status === 410) { dead = true; break; }
        record.sentKeys.push({ key: entry.key, at: now });
        if (entry.key.startsWith('nudge:')) record.lastNudge = now;
      }
      if (dead) { await env.TALLY_PUSH.delete(name); continue; }
      record.schedule = record.schedule.filter(e => e.fireAt > now);
      await env.TALLY_PUSH.put(name, JSON.stringify(record));
    } catch { /* one bad record must not block the rest */ }
  }
}
