// functions/api/auth/finalize.js
// GET /api/auth/finalize?t=SESSION_TOKEN
// Sets the session cookie via a browser navigation response (302 redirect to /).
// Used by Brave Shields aggressive mode which blocks cookies set by fetch/XHR.
// The token is verified against D1 sessions before the cookie is issued.

import { cookie } from '../../_lib/response.js';

export async function onRequestGet({ request, env }) {
  const url   = new URL(request.url);
  const token = (url.searchParams.get('t') || '').trim();

  if (!token) return Response.redirect('/', 302);

  try {
    const session = await env.DB.prepare(
      'SELECT expires_at FROM sessions WHERE token=?'
    ).bind(token).first();

    if (!session || session.expires_at < Math.floor(Date.now() / 1000)) {
      return Response.redirect('/', 302);
    }

    const origin = new URL(request.url).origin;
    const headers = new Headers({
      Location: origin + '/',
      'Cache-Control': 'no-store',
    });
    headers.append('Set-Cookie', cookie(token, session.expires_at));
    // Clear stale __Host-session cookie that shadows the valid session= token
    headers.append('Set-Cookie', '__Host-session=; Path=/; Secure; SameSite=Lax; Max-Age=0');
    return new Response(null, { status: 302, headers });
  } catch(e) {
    return Response.redirect('/', 302);
  }
}
