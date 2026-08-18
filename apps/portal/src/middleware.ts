import { NextResponse, type NextRequest } from 'next/server';
import { sanitizedActionHeaders } from '@/lib/server-action-origin';

/**
 * Exists only to keep a malformed `Origin` from crashing Server Actions.
 * See `server-action-origin.ts` for the mechanism and why the header is
 * removed rather than rewritten.
 */
export function middleware(req: NextRequest): NextResponse {
  const headers = sanitizedActionHeaders(req);
  return headers ? NextResponse.next({ request: { headers } }) : NextResponse.next();
}

export const config = {
  // Server Actions POST to the page's own path, so the app's routes are the
  // whole surface that matters. Static assets are excluded because they never
  // carry an action and this would otherwise run on every one of them.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|fonts/).*)'],
};
