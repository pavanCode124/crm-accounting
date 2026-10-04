'use client';

import { useRef } from 'react';
import { setPackageTaxAction } from '@/app/actions';
import { inputClass } from './ui';

/**
 * The GST rate a package is sold at, chosen in place.
 *
 * SUBMITS ON CHANGE, with a Save button behind it for anyone without
 * JavaScript. A per-row Save that has to be pressed means a screen of thirty
 * packages is thirty round trips somebody will abandon halfway through, and a
 * half-classified catalogue is the state this column exists to prevent. The
 * button is `noscript`-visible rather than absent, so the page still works
 * without the script.
 *
 * `defaulted` is the honest distinction a plain select cannot make: 18% because
 * the agency said so, and 18% because nobody has said anything yet, look
 * identical in a dropdown. The second is a question; the first is an answer.
 */
export function PackageGstSelect({ packageId, packageName, value, defaulted, options }: {
  packageId: string;
  packageName: string;
  value: string;
  defaulted: boolean;
  options: Array<{ id: string; name: string; rateBps: number }>;
}) {
  const form = useRef<HTMLFormElement>(null);

  return (
    <form ref={form} action={setPackageTaxAction} className="flex items-center gap-2">
      <input type="hidden" name="package_id" value={packageId} />
      <input type="hidden" name="package_name" value={packageName} />
      <select
        name="tax_id"
        defaultValue={value}
        className={`${inputClass} w-[150px]`}
        onChange={() => form.current?.requestSubmit()}
        aria-label={`GST rate for ${packageName}`}
      >
        {options.map((t) => (
          <option key={t.id} value={t.id}>
            {(t.rateBps / 100).toFixed(t.rateBps % 100 ? 2 : 0)}% — {t.name}
          </option>
        ))}
      </select>
      {defaulted && (
        <span
          className="text-[11px] font-bold uppercase tracking-[0.05em] text-ink-faint"
          title="Nobody has classified this package yet, so it falls to the agency's default rate. Choosing one here makes it an answer."
        >
          default
        </span>
      )}
      <noscript><button className="text-[12px] font-bold text-brand">Save</button></noscript>
    </form>
  );
}
