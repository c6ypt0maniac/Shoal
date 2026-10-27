// Vercel Routing Middleware: forwards /api/* to the Shoal server (server/,
// hosted on Railway or any Docker host). The site and the API then share one
// origin, so GitHub sign-in cookies are first-party and no CORS is needed.
// Set SHOAL_API_URL (e.g. https://shoal-api.up.railway.app) in the Vercel
// project's environment variables; it's read at request time, so changing it
// doesn't need a rebuild.
import { rewrite } from '@vercel/functions';

export const config = { matcher: '/api/:path*' };

export default function middleware(request) {
  const api = process.env.SHOAL_API_URL;
  if (!api) return Response.json({ error: "This site isn't connected to a Shoal server yet: set SHOAL_API_URL in the Vercel project." }, { status: 503 });
  const url = new URL(request.url);
  return rewrite(new URL(url.pathname + url.search, api.replace(/\/$/, '') + '/'));
}
