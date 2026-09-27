/**
 * Where checkout pages report Content-Security-Policy violations while the
 * policy runs report-only. Each report becomes one structured log line with
 * the blocked origin and the directive; the document URL is logged without
 * its path, because the path carries the checkout token.
 */

import { NextResponse } from 'next/server';
import { summariseCspReport } from '@/lib/csp-report';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 16 * 1024;

export async function POST(req: Request): Promise<NextResponse> {
  const text = (await req.text()).slice(0, MAX_BODY_BYTES);
  const summary = summariseCspReport(text);
  if (summary) console.warn(JSON.stringify({ msg: 'checkout csp violation', ...summary }));
  return new NextResponse(null, { status: 204 });
}
