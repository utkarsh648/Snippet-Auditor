import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

// 32 random bytes → 43 base64url characters. The prefix is a readability
// hint only; the role always comes from which stored hash matches.
export function generateToken(kind) {
  if (kind !== 'dev' && kind !== 'qa') throw new Error('Token kind must be "dev" or "qa".');
  return `${kind}_${randomBytes(32).toString('base64url')}`;
}

// Tokens carry 256 bits of entropy, so a plain SHA-256 digest is enough:
// there is nothing to brute-force the way there is with human passwords.
export function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

export function hashesEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
