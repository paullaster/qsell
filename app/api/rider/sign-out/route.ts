import { NextResponse, type NextRequest } from 'next/server';
import { logoutAction } from '@/server/domains/auth/actions';

/**
 * Signing a rider out. It is a plain form post to a route outside the /rider gate: a server action posted to a /rider page is
 * answered with a redirect page when the session has lapsed or a new PIN is still to be chosen, and the app then shows
 * "an unexpected response was received". This always ends on the rider sign-in screen, whatever the state of the session.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Only a form on this site may sign someone out.
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== request.nextUrl.origin) return new NextResponse(null, { status: 403 });
  const form = new FormData();
  form.set('returnTo', '/rider/sign-in');
  try {
    await logoutAction(form);
  } catch {
    // logoutAction ends by redirecting, which is thrown; the cookies it expired are already on this response.
  }
  return NextResponse.redirect(new URL('/rider/sign-in', request.url), 303);
}
