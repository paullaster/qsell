import { NextResponse, type NextRequest } from 'next/server';
import { logoutAction } from '@/server/domains/auth/actions';

/**
 * Signing a rep out. A plain form post to a route outside the /rep gate, so it ends on the sign-in screen whatever the state of the session
 * (a server action posted to a gated page is answered with a redirect page when the session has lapsed).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Only a form on this site may sign someone out.
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== request.nextUrl.origin) return new NextResponse(null, { status: 403 });
  const form = new FormData();
  form.set('returnTo', '/login?callbackUrl=%2Frep');
  try {
    await logoutAction(form);
  } catch {
    // logoutAction ends by redirecting, which is thrown; the cookies it expired are already on this response.
  }
  return NextResponse.redirect(new URL('/login?callbackUrl=%2Frep', request.url), 303);
}
