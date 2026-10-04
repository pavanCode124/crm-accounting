import type { Metadata } from 'next';
import { Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';
import { Shell } from '@/components/Shell';
import { optionalSession } from '@/server/auth';
import { ensureDemoBooks } from '@/server/seed';
import { isDemoMode } from '@/server/db';

// The CRM's face, so the two products read as one. Loaded as a variable font
// rather than a family per weight: on the web, unlike React Native, the browser
// can pick a weight out of one file.
const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-jakarta',
  display: 'swap',
});

/**
 * Nothing in this app is prerenderable: the masthead alone reads the
 * organisation out of the ledger. Saying so here covers the routes Next
 * generates for itself — `/_not-found` in particular — which would otherwise
 * try to reach Postgres from the build machine, where there is no database and
 * no business being one.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Tripzo Finance — Travel ERP Accounting',
  description: 'Double-entry accounting for travel agencies, inside TripzoCRM.',
};

/**
 * THE SHELL IS DRAWN ONLY FOR SOMEBODY WHO IS SIGNED IN.
 *
 * It reads the organisation, the user's name and their role to draw the
 * masthead and to decide which menu entries exist, so wrapping it around the
 * sign-in screen — whose entire premise is that there is no session yet — would
 * mean each of those three carried a "nobody is signed in" branch for ever, for
 * the sake of one page.
 *
 * `optionalSession` rather than `ctx` for the same reason: this layout renders
 * for /login too, and a redirect here would be a redirect loop. The GATE is in
 * `ctx`, which every real screen calls on its first line — so a page reached
 * without a session sends the visitor to /login itself, and this layout simply
 * gets out of the way while it happens.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Still unconditional: the login screen reads nothing from the ledger, but
  // the very first request to a fresh deployment must not race the schema into
  // existence from two places at once.
  await ensureDemoBooks();
  const session = await optionalSession();

  return (
    <html lang="en" className={jakarta.variable}>
      <body style={{ fontFamily: 'var(--font-jakarta), var(--font-sans)' }}>
        {session ? (
          <Shell
            user={{ name: session.userName, role: session.role, orgName: session.orgName }}
            demo={isDemoMode()}
          >
            {children}
          </Shell>
        ) : (
          children
        )}
      </body>
    </html>
  );
}
