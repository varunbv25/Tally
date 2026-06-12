/* One-time VAPID keypair generation. Prints in web-push convention:
   public = base64url(raw uncompressed P-256 point), private = JWK d. */
import { webcrypto as wc } from 'node:crypto';

const kp = await wc.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = Buffer.from(await wc.subtle.exportKey('raw', kp.publicKey)).toString('base64url');
const jwk = await wc.subtle.exportKey('jwk', kp.privateKey);
console.log('VAPID_PUBLIC_KEY=' + pub);
console.log('VAPID_PRIVATE_KEY=' + jwk.d);
