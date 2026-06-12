// functions/_lib/response.js — shared HTTP response helpers for auth endpoints
export function genToken() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function cookie(token, exp) {
  return `__Host-session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=${new Date(exp * 1000).toUTCString()}`;
}

export function ok(data, status, setCookie) {
  const h = new Headers({ 'Content-Type': 'application/json' });
  if (setCookie) {
    h.append('Set-Cookie', setCookie);
    // Clear legacy session= cookie that may still exist from before __Host- migration
    h.append('Set-Cookie', 'session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  }
  return new Response(JSON.stringify({ ok: true, ...data }), { status, headers: h });
}

export function err(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
