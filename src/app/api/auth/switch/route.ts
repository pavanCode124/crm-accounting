import { NextResponse, type NextRequest } from 'next/server';
import { signOutOfCrm } from '@/server/crm/identity';

/**
 * Drop the CRM session and go back to the sign-in screen, carrying a reason.
 *
 * WHY A ROUTE HANDLER RATHER THAN A REDIRECT FROM THE PAGE. Clearing the
 * session means deleting an httpOnly cookie, and Next refuses a cookie write
 * from a Server Component — it would throw on exactly the page the visitor was
 * trying to read. A route handler is allowed to write cookies, so the one case
 * that needs it (signed in, but to an agency these books do not belong to) gets
 * a clean landing instead of a 500.
 *
 * `reason` is echoed into the login screen's banner. It is TRUNCATED and
 * re-encoded on the way back out, because anything in a query parameter came
 * from the URL bar and is not to be trusted at face value.
 */
export async function GET(req: NextRequest) {
  await signOutOfCrm();
  const reason = (req.nextUrl.searchParams.get('reason') ?? '').slice(0, 400);
  const to = new URL('/login', req.nextUrl.origin);
  if (reason) to.searchParams.set('error', reason);
  return NextResponse.redirect(to);
}
