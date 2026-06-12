/* Prints a fake-but-cryptographically-valid push subscription pointing
   at a local listener, then logs every push it receives. Lets the cron
   path be exercised end-to-end without a real browser endpoint. */
import { webcrypto as wc } from 'node:crypto';
import http from 'node:http';

const kp = await wc.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const p256dh = Buffer.from(await wc.subtle.exportKey('raw', kp.publicKey)).toString('base64url');
const auth = Buffer.from(wc.getRandomValues(new Uint8Array(16))).toString('base64url');

http.createServer((req, res) => {
  console.log('PUSH RECEIVED:', req.method, 'ttl=' + req.headers.ttl, 'len=' + req.headers['content-length']);
  res.writeHead(201);
  res.end();
}).listen(9999, () => {
  console.log(JSON.stringify({
    endpoint: 'http://127.0.0.1:9999/push',
    expirationTime: null,
    keys: { p256dh, auth },
  }));
});
