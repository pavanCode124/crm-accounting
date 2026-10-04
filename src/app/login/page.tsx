import { redirect } from 'next/navigation';
import { signInAction } from '@/app/actions';
import { optionalSession, AUTH_REQUIRED } from '@/server/auth';
import { CRM_BACKEND_URL } from '@/server/crm/client';
import { msg, type SearchParams } from '@/lib/range';
import { Card, Field, Banner, inputClass, btn } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Sign in with a TripzoCRM account.
 *
 * ONE SET OF CREDENTIALS FOR THE WHOLE PRODUCT. There is no account to create
 * here and no password to reset here: the agent types the email and password
 * they already use on their phone and on the web CRM, those go to the same
 * self-hosted Supabase all three authenticate against, and the node backend
 * decides which agency they belong to. Anything else would mean a second
 * password per person and a second place to revoke access from, which is how a
 * leaver keeps the books open after their CRM account is closed.
 *
 * It sits OUTSIDE the app shell on purpose. The shell reads the session to draw
 * the menu, the org name and the role badge, so rendering it around a screen
 * whose entire premise is that there is no session yet would mean every one of
 * those had a "not signed in" branch to carry for ever.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  // Already signed in: there is nothing for this screen to do, and showing a
  // sign-in form to someone who is signed in invites them to do it again.
  if (await optionalSession()) redirect('/');

  const m = await msg(await searchParams);

  return (
    <main className="mx-auto flex min-h-dvh max-w-[440px] flex-col justify-center px-5 py-10">
      <div className="mb-7">
        <h1 className="text-[22px] font-extrabold tracking-tight">TripzoCRM Finance</h1>
        <p className="mt-1 text-[13.5px] text-ink-muted">
          The books behind the agency. Sign in with your TripzoCRM account — the same email and
          password you use in the app.
        </p>
      </div>

      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      {!AUTH_REQUIRED ? (
        <Banner tone="warn">
          This deployment has no TripzoCRM connection configured, so it is running on demo books and
          needs no sign-in. Set TRIPZO_SUPABASE_ANON_KEY in .env.local to connect it to a real
          agency.
        </Banner>
      ) : (
        <Card title="Sign in">
          <form action={signInAction} className="space-y-4">
            {/*
              Carried through the sign-in so a visitor who followed a link to a
              deep page lands back on it instead of on the dashboard. Only a
              PATH is ever honoured — see `safeReturn` in actions.ts — because a
              login form that redirects to whatever a query parameter says is an
              open redirect, and an open redirect on a login form is a phishing
              page hosted by the agency.
            */}
            <input type="hidden" name="next" value={(await searchParams).next?.toString() ?? ''} />
            <Field label="Email">
              <input
                name="email" type="email" required autoComplete="username" autoFocus
                placeholder="you@agency.com" className={inputClass}
              />
            </Field>
            <Field label="Password">
              <input
                name="password" type="password" required autoComplete="current-password"
                placeholder="••••••••" className={inputClass}
              />
            </Field>
            <button className={`${btn.primary} w-full`}>Sign in</button>
          </form>
          <p className="mt-4 text-[12px] text-ink-faint">
            Authenticated against TripzoCRM at {CRM_BACKEND_URL}. Your password is used for this one
            request and is never stored by the finance app.
          </p>
        </Card>
      )}
    </main>
  );
}
