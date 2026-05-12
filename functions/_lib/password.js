// functions/_lib/password.js
const ITERATIONS = 100000;
const LEGACY_ITERATIONS = 100000;

// Hash format: `<hex-salt>:<hex-derived>:<iterations>`
// Legacy (100k) hashes omit the third segment — detected at verify time.
export async function hashPassword(pw) {
  const enc  = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key  = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
  const h2   = b => b.toString(16).padStart(2, '0');
  return [...salt].map(h2).join('') + ':' + [...new Uint8Array(bits)].map(h2).join('') + ':' + ITERATIONS;
}

// Returns { valid: bool, needsRehash: bool }.
// needsRehash is true when the stored hash used fewer iterations than current target.
export async function verifyPassword(pw, stored) {
  const parts = (stored || '').split(':');
  if (parts.length < 2) return { valid: false, needsRehash: false };
  const iterations = parts.length >= 3 ? parseInt(parts[2], 10) : LEGACY_ITERATIONS;
  const salt = new Uint8Array(parts[0].match(/.{2}/g).map(b => parseInt(b, 16)));
  const enc  = new TextEncoder();
  const key  = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  const hex  = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  return { valid: hex === parts[1], needsRehash: iterations < ITERATIONS };
}
