import type { Metadata } from 'next';
import { Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';
import { Shell } from '@/components/Shell';
import { ctx } from '@/server/bootstrap';
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

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await ctx();
  return (
    <html lang="en" className={jakarta.variable}>
      <body style={{ fontFamily: 'var(--font-jakarta), var(--font-sans)' }}>
        <Shell user={{ name: session.userName, role: session.role, orgName: session.orgName }} demo={isDemoMode()}>
          {children}
        </Shell>
      </body>
    </html>
  );
}
