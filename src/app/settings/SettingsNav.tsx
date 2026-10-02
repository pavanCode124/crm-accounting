'use client';

import { usePathname } from 'next/navigation';
import { Tabs } from '@/components/ui';

/**
 * ONE registry of settings screens, in the order an agency meets them.
 *
 * Settings used to be a single page, which worked while there were two things
 * to set. It stopped working the moment configuration became the product's
 * answer to "we are a different agency from the one you seeded": an agency
 * onboarding itself has to walk a sequence — who we are, where the money
 * lands, what the engine should default to, how our documents are numbered —
 * and a sequence is a set of screens, not a scroll.
 *
 * The order here IS that sequence, which is why Organisation is first and the
 * destructive reset is last.
 */
export const SETTINGS_TABS: Array<{ label: string; href: string }> = [
  { label: 'Overview', href: '/settings' },
  { label: 'Agency', href: '/settings/organisation' },
  { label: 'Bank & Cash', href: '/settings/bank-accounts' },
  { label: 'Default Accounts', href: '/settings/accounts' },
  { label: 'Numbering', href: '/settings/numbering' },
  { label: 'Payment Terms', href: '/settings/payment-terms' },
  { label: 'Branches & Agents', href: '/settings/dimensions' },
  { label: 'Products', href: '/settings/products' },
  { label: 'Users & Roles', href: '/settings/users' },
  { label: 'CRM Sync', href: '/settings/crm-sync' },
];

export function SettingsNav() {
  const pathname = usePathname();
  // Longest matching prefix wins, so `/settings/products/new` keeps Products
  // lit rather than falling back to the Overview tab at `/settings`.
  const active = SETTINGS_TABS
    .filter((t) => pathname === t.href || pathname.startsWith(`${t.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? '/settings';
  return <Tabs tabs={SETTINGS_TABS} active={active} />;
}
