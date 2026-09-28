'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { NAV, SETTINGS_ITEM, type NavSection } from '@/lib/nav';
import { can, type FinanceCap } from '@/lib/accounting';

/**
 * The frame every screen sits in: a two-row masthead across the top, and
 * nothing down the side.
 *
 * WHY THE RAIL WENT. A finance screen is a WIDE screen — a trial balance
 * carries six money columns, a general ledger nine, and 264px of permanent
 * chrome is 264px the figures do not get. The menu is the same single registry
 * in src/lib/nav.ts; only its shape changed, from a column that is always open
 * to a row that opens on demand.
 *
 * Client-side for three reasons and no others: the active-route highlight needs
 * the pathname, the dropdowns need open/closed state, and the mobile sheet
 * needs to toggle. Everything inside `children` is still a server component, so
 * no ledger data crosses into the browser bundle.
 */

export interface ShellUser {
  name: string; role: string; orgName: string;
}

export function Shell({ user, children }: { user: ShellUser; children: React.ReactNode }) {
  const pathname = usePathname();

  const visible = NAV
    .map((s) => ({ ...s, items: s.items.filter((i) => !i.cap || can(user.role, i.cap as FinanceCap)) }))
    .filter((s) => s.items.length);

  return (
    <div className="flex min-h-screen flex-col">
      <Masthead user={user} sections={visible} pathname={pathname} />
      <main className="flex-1 px-4 py-6 md:px-8 md:py-7">{children}</main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The masthead
// ---------------------------------------------------------------------------

function Masthead({ user, sections, pathname }: {
  user: ShellUser; sections: NavSection[]; pathname: string;
}) {
  // One `open` for the whole bar rather than one per section: only ever a
  // single dropdown is down, and a shared key makes "click another section,
  // that one opens instead" fall out for free.
  const [open, setOpen] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  // Navigating is what closes a menu. Without this the dropdown stays down over
  // the page it just navigated to, which reads as a broken click.
  useEffect(() => { setOpen(null); setSheet(false); }, [pathname]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(null);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(null); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <header className="no-print sticky top-0 z-30" style={{ background: 'var(--nav-bg)' }}>
      {/* Row one: identity, search, the things you do rather than the places you go. */}
      <div className="flex items-center gap-4 px-4 py-2.5 md:px-8"
        style={{ borderBottom: '1px solid var(--nav-line)' }}>
        <Brand orgName={user.orgName} />

        <form action="/search" className="ml-2 hidden min-w-0 flex-1 md:block md:max-w-md">
          <input
            name="q"
            placeholder="Search invoices, bills, customers, bookings…"
            className="w-full rounded-[10px] px-3.5 py-1.5 text-[13px] text-white outline-none focus:border-brand"
            style={{ background: 'var(--nav-input)', border: '1px solid var(--nav-line)' }}
          />
        </form>

        <div className="ml-auto flex items-center gap-3">
          <Link href="/sales/invoices/new"
            className="hidden rounded-[10px] bg-action px-3.5 py-1.5 text-[13px] font-bold text-white hover:bg-action-dark sm:block">
            + New Invoice
          </Link>
          <Link href={SETTINGS_ITEM.href} className="hidden text-[13px] font-semibold md:block"
            style={{ color: pathname.startsWith('/settings') ? '#ffffff' : 'var(--nav-text)' }}>
            Settings
          </Link>
          <div className="hidden text-right sm:block">
            <div className="text-[12.5px] font-bold leading-tight text-white">{user.name}</div>
            <div className="text-[10px] font-bold uppercase tracking-[0.1em]"
              style={{ color: 'var(--nav-text-dim)' }}>{user.role}</div>
          </div>
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[12.5px] font-extrabold text-white"
            style={{ background: 'var(--sidebar-active)' }}>
            {user.name.slice(0, 1)}
          </span>
          <button
            onClick={() => setSheet((v) => !v)}
            aria-label="Menu"
            aria-expanded={sheet}
            className="grid h-8 w-8 place-items-center rounded-[9px] text-[15px] text-white md:hidden"
            style={{ background: 'var(--nav-input)' }}>
            {sheet ? '✕' : '☰'}
          </button>
        </div>
      </div>

      {/* Row two: the menu itself. */}
      <div ref={barRef} className="relative hidden md:block">
        {/*
          NO `overflow` ON THIS ROW, and it wraps rather than scrolls.
          The dropdowns hang BELOW the bar as absolutely-positioned children of
          it. `overflow-x: auto` would clip them dead: CSS computes a `visible`
          overflow on one axis to `auto` when the other axis is not visible, so
          a horizontally-scrolling bar silently clips vertically too — the menu
          opens, and nothing appears. Wrapping costs a second row of buttons on
          a narrow desktop window, which is the cheaper of the two problems.
        */}
        <nav className="flex flex-wrap items-stretch gap-0.5 px-5 md:px-7">
          {sections.map((s) => (
            <SectionButton key={s.key} section={s} pathname={pathname}
              open={open === s.key}
              onToggle={() => setOpen((k) => (k === s.key ? null : s.key))} />
          ))}
        </nav>
      </div>

      {sheet && <MobileSheet sections={sections} pathname={pathname} />}
    </header>
  );
}

function Brand({ orgName }: { orgName: string }) {
  return (
    <Link href="/" className="flex shrink-0 items-center gap-2.5">
      <span
        className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] text-[15px] font-extrabold text-white"
        style={{ background: 'linear-gradient(140deg, var(--color-brand) 0%, var(--color-brand-deep) 100%)' }}
      >
        ₹
      </span>
      <span className="hidden min-w-0 lg:block">
        <span className="block truncate text-[14px] font-extrabold leading-tight text-white">Tripzo Finance</span>
        <span className="block truncate text-[9.5px] font-bold uppercase tracking-[0.12em]"
          style={{ color: 'var(--nav-text-dim)' }}>
          {orgName}
        </span>
      </span>
    </Link>
  );
}

/**
 * One section of the bar: the button, and the panel it drops.
 *
 * NO SECTION COLOUR ANYWHERE IN HERE, deliberately. The bar used to carry a
 * coloured dot beside every label and a coloured underline under the active
 * one — nine hues competing for attention above a page whose own use of colour
 * is meaningful (red is money going out, green is money coming in). Chrome that
 * borrows the same vocabulary makes the figures harder to read, not easier.
 * Position and weight mark the active section instead, which is what a ledger
 * product should look like.
 */
function SectionButton({ section, pathname, open, onToggle }: {
  section: NavSection; pathname: string; open: boolean; onToggle: () => void;
}) {
  const active = section.items.some((i) => (i.match ? pathname.startsWith(i.match) : pathname === i.href));
  const wrapRef = useRef<HTMLDivElement>(null);
  const [alignRight, setAlignRight] = useState(false);

  /**
   * Which edge the panel hangs from, decided at the moment it opens.
   *
   * A left-anchored panel on the last button runs off the right of the window
   * and takes the whole page into horizontal scroll with it. Measured rather
   * than assumed from the section's index, because the bar WRAPS: on a narrow
   * window the last section can be the first button of the second row, where
   * left-anchoring is the correct choice after all.
   */
  function toggle() {
    const box = wrapRef.current?.getBoundingClientRect();
    if (box) setAlignRight(box.left > window.innerWidth / 2);
    onToggle();
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="true"
        className="flex items-center gap-1.5 whitespace-nowrap px-3.5 py-2.5 text-[13px] font-semibold"
        style={{
          color: active || open ? '#ffffff' : 'var(--nav-text)',
          // A plain white rule, the same on every section. It says "you are
          // here" without also saying "and here is a colour to remember".
          boxShadow: active ? 'inset 0 -2px 0 0 #ffffff' : undefined,
          background: open ? 'var(--nav-input)' : 'transparent',
        }}
      >
        {section.label}
        <span className="text-[8px] leading-none opacity-55">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div
          className={`absolute top-full z-40 mt-1 min-w-[250px] overflow-hidden rounded-card border border-line bg-surface py-1.5 ${
            alignRight ? 'right-0' : 'left-0'}`}
          style={{ boxShadow: '0 18px 44px rgba(20,16,31,0.22)' }}
        >
          {section.items.map((item) => {
            const on = item.match ? pathname.startsWith(item.match) : pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block px-4 py-2 text-[13.5px] ${
                  on ? 'bg-canvas font-bold text-ink' : 'font-medium text-ink-muted hover:bg-canvas hover:text-ink'}`}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The menu below the md breakpoint: every section, expanded, in one sheet.
 *
 * Not a dropdown inside a dropdown. On a phone the menu is opened with intent —
 * the reader already knows where they are going — and one scroll beats two taps
 * per destination.
 */
function MobileSheet({ sections, pathname }: { sections: NavSection[]; pathname: string }) {
  return (
    <div className="max-h-[70vh] overflow-y-auto border-t border-line bg-surface px-4 py-3 md:hidden">
      <form action="/search" className="mb-3">
        <input name="q" placeholder="Search…"
          className="w-full rounded-[10px] border border-line bg-canvas px-3.5 py-2 text-[13.5px] outline-none focus:border-brand" />
      </form>
      {sections.map((s) => (
        <div key={s.key} className="mb-3.5">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-ink-faint">
            {s.label}
          </div>
          <div className="grid grid-cols-2 gap-1">
            {s.items.map((item) => {
              const on = item.match ? pathname.startsWith(item.match) : pathname === item.href;
              return (
                <Link key={item.href} href={item.href}
                  className={`truncate rounded-[9px] px-3 py-2 text-[13px] ${
                    on ? 'bg-canvas font-bold text-ink' : 'font-medium text-ink-muted hover:bg-canvas'}`}>
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
      <Link href={SETTINGS_ITEM.href}
        className="block rounded-[9px] px-3 py-2 text-[13px] font-semibold text-ink hover:bg-canvas">
        Settings
      </Link>
    </div>
  );
}
