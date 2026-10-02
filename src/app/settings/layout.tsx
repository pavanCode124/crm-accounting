import type { ReactNode } from 'react';
import { SettingsNav } from './SettingsNav';

/**
 * Every settings screen wears the same tab strip, from one place.
 *
 * The nav registry in src/lib/nav.ts owns the PRODUCT's menu; this owns
 * configuration's. Keeping them apart is deliberate: a settings screen added
 * here must not add a ninth entry to a masthead that is already full, and a
 * person configuring an agency is doing one job across ten screens rather than
 * visiting ten unrelated places.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SettingsNav />
      {children}
    </>
  );
}
