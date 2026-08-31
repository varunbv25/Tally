/* Exercises the REAL Worker /ledger handler (worker/src/index.js), not a
   re-implementation of it, against a fake KV + a real HMAC token. Guards the
   stale-write rejection that makes last-write-wins actually hold. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'worker', 'src', 'index.js');

/* The Worker is an ES module importing a push library we don't need here.
   Strip the import and load it as one, so the handler under test is the
   deployed source rather than a copy. */
async function loadWorker() {
  const src = fs.readFileSync(SRC, 'utf8')
    .replace(/^import .*$/m, 'const buildPushPayload = () => { throw new Error("unused"); };');
  const url = 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');
  return import(url);
}

function fakeKV() {
  const m = new Map();
  return {
    _m: m,
    get: async (k, type) => {
      const v = m.get(k);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => { m.set(k, String(v)); },
    delete: async k => { m.delete(k); },
    list: async () => ({ keys: [...m.keys()].map(name => ({ name })) }),
  };
}

const AUTH_SECRET = 'test-secret';

/* Mint a token with the Worker's own scheme. The /auth/start flow can't be
   driven here (it requires email delivery to be configured), so we reproduce
   mintToken: base64url(JSON payload) + '.' + HMAC-SHA256 of that body. */
async function mintToken(secret, sub, ttlDays = 90) {
  const b64urlStr = s => Buffer.from(s, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const body = b64urlStr(JSON.stringify({ sub, exp: Date.now() + ttlDays * 86_400_000 }));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  let s = ''; for (const b of sig) s += String.fromCharCode(b);
  return `${body}.${Buffer.from(s, 'binary').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

async function ledger(worker, env, token, method, body) {
  const req = new Request('https://x/ledger', {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const res = await worker.default.fetch(req, env, { waitUntil() {} });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

test('the real Worker refuses a ledger write older than what it holds', async () => {
  const worker = await loadWorker();
  const env = { AUTH_SECRET, TALLY_SYNC: fakeKV(), TALLY_PUSH: fakeKV() };

  const token = await mintToken(AUTH_SECRET, 'account-hash');

  // Sanity: the Worker must actually accept this token, or the rest is vacuous.
  const probe = await ledger(worker, env, token, 'GET');
  assert.strictEqual(probe.status, 200, 'token accepted by the real verifyToken');

  // Newer write lands.
  let r = await ledger(worker, env, token, 'PUT', {
    state: { people: [{ id: 'p1', name: 'keep' }] }, updatedAt: 2000,
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.updatedAt, 2000);

  // Older write must be refused, not applied.
  r = await ledger(worker, env, token, 'PUT', { state: { people: [] }, updatedAt: 1000 });
  assert.strictEqual(r.body.stale, true, 'reported stale');
  assert.strictEqual(r.body.updatedAt, 2000, 'returned the winning version');

  const got = await ledger(worker, env, token, 'GET');
  assert.strictEqual(got.body.updatedAt, 2000, 'stored copy untouched');
  assert.strictEqual(got.body.state.people.length, 1, 'the real ledger survived');
  assert.strictEqual(got.body.state.people[0].name, 'keep');

  // An equal-or-newer write still applies.
  r = await ledger(worker, env, token, 'PUT', {
    state: { people: [{ id: 'p2', name: 'newer' }] }, updatedAt: 3000,
  });
  assert.strictEqual(r.body.stale, undefined, 'newer write accepted');
  const after = await ledger(worker, env, token, 'GET');
  assert.strictEqual(after.body.state.people[0].name, 'newer');
});

test('the real Worker rejects an unauthenticated ledger read', async () => {
  const worker = await loadWorker();
  const env = { AUTH_SECRET, TALLY_SYNC: fakeKV(), TALLY_PUSH: fakeKV() };
  const res = await worker.default.fetch(
    new Request('https://x/ledger', { method: 'GET' }), env, { waitUntil() {} });
  assert.strictEqual(res.status, 401);
});

/* A ledger reply is a per-account, per-moment answer. Cached anywhere between
   the Worker and the page, it is indistinguishable from a device that simply
   never receives the other device's changes. */
test('ledger replies forbid caching', async () => {
  const worker = await loadWorker();
  const env = { AUTH_SECRET, TALLY_SYNC: fakeKV(), TALLY_PUSH: fakeKV() };
  const token = await mintToken(AUTH_SECRET, 'account-hash');

  for (const r of [
    await ledger(worker, env, token, 'GET'),
    await ledger(worker, env, token, 'PUT', { state: { people: [] }, updatedAt: 1 }),
  ]) {
    assert.match(r.headers.get('cache-control') || '', /no-store/);
  }
});

/* Versions are wall-clock milliseconds, so the devices comparing them need a
   clock they share. The Worker's is the only candidate, so it ships in every
   reply and the client stamps against it. */
test('every ledger reply carries the server clock', async () => {
  const worker = await loadWorker();
  const env = { AUTH_SECRET, TALLY_SYNC: fakeKV(), TALLY_PUSH: fakeKV() };
  const token = await mintToken(AUTH_SECRET, 'account-hash');

  const before = Date.now();
  const empty = await ledger(worker, env, token, 'GET');
  assert.ok(empty.body.now >= before, 'GET on an empty account still reports the time');

  const put = await ledger(worker, env, token, 'PUT', { state: { people: [] }, updatedAt: 2000 });
  assert.ok(put.body.now >= before, 'accepted PUT reports the time');

  const stale = await ledger(worker, env, token, 'PUT', { state: { people: [] }, updatedAt: 1000 });
  assert.strictEqual(stale.body.stale, true);
  assert.ok(stale.body.now >= before, 'a refused PUT reports it too — that is when a skewed device needs it');

  const got = await ledger(worker, env, token, 'GET');
  assert.ok(got.body.now >= before, 'GET with a stored ledger reports the time');
  assert.strictEqual(got.body.updatedAt, 2000, 'and still returns the stored version');
});
