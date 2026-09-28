import Link from 'next/link';
import type { ReactNode } from 'react';
import { fmt, fmtCompact } from '@/lib/money';
import { stateChip, titleise, drCrLabel } from '@/lib/accounting';

/**
 * The shared furniture: cards, tables, chips, stat tiles, money.
 *
 * Server components, all of them. A finance screen is a read of the ledger
 * rendered once — there is no client state to keep, and shipping React state
 * for a table of postings would be work done twice for no interaction.
 */

export function PageHeader({ title, subtitle, actions, accent }: {
  title: string; subtitle?: string; actions?: ReactNode; accent?: string;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[26px] font-extrabold tracking-[-0.6px] leading-tight"
          style={accent ? { color: accent } : undefined}>
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-[14px] text-ink-muted max-w-2xl">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 no-print">{actions}</div>}
    </div>
  );
}

export function Card({ title, subtitle, actions, children, padded = true, className = '' }: {
  title?: string; subtitle?: string; actions?: ReactNode; children: ReactNode;
  padded?: boolean; className?: string;
}) {
  return (
    <section className={`rounded-card border border-line bg-surface ${className}`}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            {title && <h2 className="text-[15px] font-bold">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[13px] text-ink-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 no-print">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

/**
 * A KPI tile.
 *
 * `compact` prints ₹42.5L rather than ₹42,50,000.00: a dashboard is read at a
 * glance and the exact paise belong on the report the tile links to.
 */
export function StatTile({ label, value, hint, tone = 'neutral', href, compact = true }: {
  label: string; value: number | string; hint?: string;
  tone?: 'neutral' | 'positive' | 'negative' | 'warn'; href?: string; compact?: boolean;
}) {
  const toneClass = {
    neutral: 'text-ink',
    positive: 'text-positive',
    negative: 'text-negative',
    warn: 'text-warn',
  }[tone];
  const body = (
    <div className="rounded-card border border-line bg-surface px-5 py-4 h-full transition-colors hover:border-brand">
      <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-ink-faint">{label}</div>
      <div className={`mt-2 text-[24px] font-extrabold num !text-left ${toneClass}`}>
        {typeof value === 'number' ? (compact ? fmtCompact(value) : fmt(value)) : value}
      </div>
      {hint && <div className="mt-1 text-[12px] text-ink-muted">{hint}</div>}
    </div>
  );
  return href ? <Link href={href} className="block h-full">{body}</Link> : body;
}

export function Chip({ state, label }: { state: string; label?: string }) {
  const c = stateChip(state);
  return (
    <span className="inline-flex items-center rounded-full px-2.5 py-[3px] text-[11px] font-bold whitespace-nowrap"
      style={{ background: c.bg, color: c.fg }}>
      {label ?? titleise(state)}
    </span>
  );
}

/** Money in a table cell. Negative reads red; zero reads as a dash. */
export function Money({ value, bold, dash = true, compact = false, sign = false }: {
  value: number; bold?: boolean; dash?: boolean; compact?: boolean; sign?: boolean;
}) {
  if (value === 0 && dash) return <span className="num text-ink-faint">—</span>;
  return (
    <span className={`num ${bold ? 'font-bold' : ''} ${value < 0 ? 'text-negative' : ''}`}>
      {compact ? fmtCompact(value) : fmt(value, { sign })}
    </span>
  );
}

/**
 * A balance written the way an accountant writes one: magnitude, then side.
 *
 * "45,000.00 Cr", never "-45,000.00". The minus sign is an arithmetic artefact
 * of storing the balance as `debit - credit`; on a ledger it means nothing, and
 * a red negative on a payables account reads as an error when it is in fact the
 * perfectly normal state of that account. Used for the running-balance and
 * closing-balance columns, where a single column has to carry both sides.
 *
 * Where there is room for TWO columns, prefer two — `drCr()` in lib/accounting
 * splits the figure and the reader never has to parse a suffix at all.
 */
export function DrCrMoney({ value, bold }: { value: number; bold?: boolean }) {
  const side = drCrLabel(value);
  if (!side) return <span className="num text-ink-faint">—</span>;
  return (
    <span className={`num ${bold ? 'font-bold' : ''}`}>
      {fmt(Math.abs(value))}
      <span className="ml-1 text-[11px] font-bold text-ink-faint">{side}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export function Table({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className="scroll-x">
      <table className={`w-full border-collapse text-[13.5px] ${className}`}>{children}</table>
    </div>
  );
}

/**
 * Tailwind scans source for whole class names, so an interpolated
 * `text-${align}` produces no CSS at all. The map keeps the three real class
 * names literal and visible to the scanner.
 */
const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

export function Th({ children, align = 'left', width, colSpan }: {
  children?: ReactNode; align?: 'left' | 'right' | 'center'; width?: string; colSpan?: number;
}) {
  return (
    <th colSpan={colSpan} style={width ? { width } : undefined}
      className={`border-b border-line px-4 py-2.5 text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint whitespace-nowrap ${ALIGN[align]}`}>
      {children}
    </th>
  );
}

export function Td({ children, align = 'left', className = '', colSpan }: {
  children?: ReactNode; align?: 'left' | 'right' | 'center'; className?: string; colSpan?: number;
}) {
  return (
    <td colSpan={colSpan}
      className={`border-b border-line px-4 py-2.5 align-top ${ALIGN[align]} ${className}`}>
      {children}
    </td>
  );
}

export function Tr({ children, href, muted }: { children: ReactNode; href?: string; muted?: boolean }) {
  // A whole-row link is a nested-anchor problem in HTML, so the row highlights
  // and the first cell carries the actual link.
  return (
    <tr className={`${href ? 'hover:bg-canvas' : ''} ${muted ? 'opacity-60' : ''}`}>
      {children}
    </tr>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="px-6 py-14 text-center">
      <p className="text-[15px] font-semibold text-ink-muted">{title}</p>
      {hint && <p className="mx-auto mt-1.5 max-w-md text-[13px] text-ink-faint">{hint}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buttons and links
// ---------------------------------------------------------------------------

const BTN_BASE = 'inline-flex items-center justify-center gap-1.5 rounded-[10px] px-3.5 py-2 text-[13px] font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

export const btn = {
  primary: `${BTN_BASE} bg-action text-white hover:bg-action-dark`,
  brand: `${BTN_BASE} bg-brand text-white hover:bg-brand-dark`,
  ghost: `${BTN_BASE} border border-line bg-surface hover:bg-canvas`,
  danger: `${BTN_BASE} border border-line text-negative hover:bg-negative-soft`,
  quiet: 'text-[13px] font-semibold text-brand hover:underline',
};

export function LinkButton({ href, children, variant = 'ghost' }: {
  href: string; children: ReactNode; variant?: 'primary' | 'brand' | 'ghost';
}) {
  return <Link href={href} className={btn[variant]}>{children}</Link>;
}

/**
 * A TOGGLE SWITCH THAT IS A SUBMIT BUTTON.
 *
 * Every setting in this product is a form post, and this one stays that way:
 * the switch is the button, the button is inside a `<form action={...}>`, and
 * flipping it is an ordinary server action with an audit row behind it. There
 * is no onChange, no fetch and no optimistic state, so it behaves identically
 * with JavaScript disabled and cannot show "on" for a change the server
 * refused — which for an accounting flag is the whole point.
 *
 * The visual is the usual pill-and-knob. `title` matters more than it looks:
 * on a table of sixty rows of identical switches, the hover text is what tells
 * the reader which account they are about to change.
 */
export function ToggleSwitch({ on, title, disabled }: {
  on: boolean; title: string; disabled?: boolean;
}) {
  return (
    <button
      type="submit"
      title={title}
      disabled={disabled}
      aria-pressed={on}
      className={`relative inline-flex h-[22px] w-[40px] shrink-0 items-center rounded-full border transition-colors
        disabled:cursor-not-allowed disabled:opacity-40
        ${on ? 'border-positive bg-positive' : 'border-line bg-canvas'}`}
    >
      <span
        className={`absolute h-[16px] w-[16px] rounded-full bg-surface shadow-sm transition-all
          ${on ? 'left-[21px]' : 'left-[2px]'}`}
      />
    </button>
  );
}

/** The blue-ish reference link used on every document number in a list. */
export function RefLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} className="font-bold text-brand hover:underline">{children}</Link>;
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export const inputClass =
  'w-full rounded-[10px] border border-line bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-brand';

export function Field({ label, children, hint, wide }: {
  label: string; children: ReactNode; hint?: string; wide?: boolean;
}) {
  return (
    <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="mb-1.5 block text-[12px] font-bold text-ink-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-ink-faint">{hint}</span>}
    </label>
  );
}

/**
 * A banner for the thing a finance screen most needs to say: what went wrong,
 * or what just happened. Read from the query string so a server action can
 * redirect with it and the message survives the navigation.
 */
export function Banner({ tone, children }: { tone: 'error' | 'ok' | 'warn' | 'info'; children: ReactNode }) {
  const styles = {
    error: 'bg-negative-soft text-negative border-negative/25',
    ok: 'bg-positive-soft text-positive border-positive/25',
    warn: 'bg-warn-soft text-warn border-warn/25',
    info: 'bg-brand-soft text-brand border-brand/25',
  }[tone];
  return (
    <div className={`mb-5 rounded-[10px] border px-4 py-3 text-[13px] font-semibold ${styles}`}>
      {children}
    </div>
  );
}

/** Tab strip for a detail page — Overview / Invoices / Ledger and so on. */
export function Tabs({ tabs, active }: {
  tabs: Array<{ label: string; href: string; count?: number }>; active: string;
}) {
  return (
    <nav className="mb-5 flex gap-1 border-b border-line no-print">
      {tabs.map((t) => {
        const on = t.href === active;
        return (
          <Link key={t.href} href={t.href}
            className={`-mb-px border-b-2 px-3.5 py-2.5 text-[13.5px] font-bold ${
              on ? 'border-brand text-brand'
                : 'border-transparent text-ink-muted hover:text-ink'}`}>
            {t.label}
            {t.count !== undefined && (
              <span className="ml-1.5 text-[11px] text-ink-faint">{t.count}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

/** Two-column label/value list, for document headers and summaries. */
export function DefList({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid gap-x-6 gap-y-2.5 text-[13.5px] sm:grid-cols-[auto_1fr]">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-ink-faint">{k}</dt>
          <dd className="font-semibold">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A horizontal bar, for "where the money went" and budget variance.
 * Deliberately not a chart library: one div with a width is exact, prints
 * correctly and costs nothing.
 */
export function Bar({ value, max, color }: { value: number; max: number; color?: string }) {
  const pct = max === 0 ? 0 : Math.min(Math.abs(value / max) * 100, 100);
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-canvas">
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color ?? 'var(--color-brand)' }} />
    </div>
  );
}
