/* Tally backend — two independent, opt-in services on one Worker:

   1. PUSH (TALLY_PUSH KV + cron): stores push subscriptions plus their
      client-projected notification schedules and Web-Pushes due entries.
      The ledger itself never reaches this path.

   2. CLOUD SYNC (TALLY_SYNC KV): opt-in email sign-in and a single
      encrypted-at-rest ledger blob per account, so one person can mirror
      their ledger across devices. Sign-in is a 6-digit code emailed to the
      user; a successful code mints an HMAC-signed bearer token. The Worker
      stores whatever JSON blob the client uploads under a hash of the
      email — it never parses the ledger. Phone sign-in is intentionally
      not offered (it would require a paid SMS gateway).

   Both services are dormant unless their KV binding / secrets are present,
   so a bare deploy keeps working exactly as before. */

import { buildPushPayload } from '@block65/webcrypto-web-push';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json', ...CORS },
  });

/* ---------- small crypto helpers ---------- */

const enc = new TextEncoder();

async function sha256hex(str) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const endpointKey = sha256hex;                 // push subscriptions key on the endpoint URL

/* normalize so "Foo@Bar.com " and "foo@bar.com" are the same account */
const normalizeEmail = e => String(e || '').trim().toLowerCase();
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64urlStr = str => b64url(enc.encode(str));

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return b64url(new Uint8Array(sig));
}

/* token = base64url(payloadJSON) . hmac(secret, that)  — stateless & tamper-evident */
async function mintToken(secret, sub, ttlDays = 90) {
  const payload = { sub, exp: Date.now() + ttlDays * 86_400_000 };
  const body = b64urlStr(JSON.stringify(payload));
  return `${body}.${await hmac(secret, body)}`;
}

async function verifyToken(secret, token) {
  if (!secret || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig || (await hmac(secret, body)) !== sig) return null;
  try {
    const payload = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
    if (!payload.sub || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function bearer(req) {
  const h = req.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

/* ---------- email delivery (Resend; no-op-with-error if unconfigured) ---------- */

async function sendCodeEmail(env, email, code) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: email,
      subject: 'Your Tally sign-in code',
      text: `Your Tally sign-in code is ${code}\n\nIt expires in 10 minutes. `
          + `If you didn't request it, you can ignore this email.`,
    }),
  });
  return res.ok;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      /* ---------------- cloud sync (opt-in email accounts) ---------------- */
      if (path.startsWith('/auth/') || path === '/ledger') {
        if (!env.TALLY_SYNC || !env.AUTH_SECRET) return json({ error: 'sync not configured' }, 503);
        return await handleSync(req, env, path);
      }

      /* ---------------- push (unchanged) ---------------- */
      if (path === '/subscribe' && req.method === 'POST') {
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
      if (path === '/sync' && req.method === 'POST') {
        const { endpoint } = await req.json();
        const record = await env.TALLY_PUSH.get(await endpointKey(endpoint), 'json');
        if (!record) return json({ error: 'unknown subscription' }, 404);
        return json({ sentKeys: record.sentKeys.map(s => s.key), lastNudge: record.lastNudge });
      }
      if (path === '/subscribe' && req.method === 'DELETE') {
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

/* ---------- cloud sync handlers ---------- */

async function handleSync(req, env, path) {
  /* Request a sign-in code. Rate-limited to one code per minute per email;
     the code is stored hashed (never in clear) with a 10-minute TTL. */
  if (path === '/auth/start' && req.method === 'POST') {
    const { email: raw } = await req.json();
    const email = normalizeEmail(raw);
    if (!validEmail(email)) return json({ error: 'invalid email' }, 400);

    const hash = await sha256hex(email);
    const otpKey = `otp:${hash}`;
    const existing = await env.TALLY_SYNC.get(otpKey, 'json');
    if (existing && Date.now() - existing.sentAt < 60_000) {
      return json({ error: 'please wait a minute before requesting another code' }, 429);
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = await sha256hex(`${code}.${hash}.${env.AUTH_SECRET}`);
    await env.TALLY_SYNC.put(otpKey, JSON.stringify({
      codeHash, sentAt: Date.now(), attempts: 0,
    }), { expirationTtl: 600 });

    const sent = await sendCodeEmail(env, email, code);
    if (!sent) return json({ error: 'email delivery not configured on the server' }, 503);
    return json({ ok: true });
  }

  /* Verify a code → mint a bearer token. Five wrong tries burns the code. */
  if (path === '/auth/verify' && req.method === 'POST') {
    const { email: raw, code } = await req.json();
    const email = normalizeEmail(raw);
    const hash = await sha256hex(email);
    const otpKey = `otp:${hash}`;
    const rec = await env.TALLY_SYNC.get(otpKey, 'json');
    if (!rec) return json({ error: 'code expired — request a new one' }, 400);
    if (rec.attempts >= 5) { await env.TALLY_SYNC.delete(otpKey); return json({ error: 'too many attempts — request a new code' }, 429); }

    const codeHash = await sha256hex(`${String(code || '').trim()}.${hash}.${env.AUTH_SECRET}`);
    if (codeHash !== rec.codeHash) {
      await env.TALLY_SYNC.put(otpKey, JSON.stringify({ ...rec, attempts: rec.attempts + 1 }),
        { expirationTtl: 600 });
      return json({ error: 'incorrect code' }, 401);
    }

    await env.TALLY_SYNC.delete(otpKey);
    const token = await mintToken(env.AUTH_SECRET, hash);
    return json({ ok: true, token, email });
  }

  /* Ledger blob — one per account, opaque to the server. */
  if (path === '/ledger') {
    const payload = await verifyToken(env.AUTH_SECRET, bearer(req));
    if (!payload) return json({ error: 'unauthorized' }, 401);
    const key = `ledger:${payload.sub}`;

    if (req.method === 'GET') {
      const rec = await env.TALLY_SYNC.get(key, 'json');
      return json(rec || { state: null, updatedAt: 0 });
    }
    if (req.method === 'PUT') {
      const { state, updatedAt } = await req.json();
      if (state == null || typeof updatedAt !== 'number') return json({ error: 'bad request' }, 400);
      await env.TALLY_SYNC.put(key, JSON.stringify({ state, updatedAt }));
      return json({ ok: true, updatedAt });
    }
  }

  return json({ error: 'not found' }, 404);
}

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
