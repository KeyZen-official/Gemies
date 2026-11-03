'use client';
import { useId, useState } from 'react';

/**
 * A labelled input for the authentication screens.
 *
 * Deliberately separate from `Field` in src/components.jsx. That component is
 * a bare label + input with no slot for a hint, an error or a trailing
 * control, and it is used by checkout, the address book and the admin forms,
 * so changing its shape or size would reach all of them.
 *
 * The sizing here also has to beat the `input, select, textarea` rule in
 * @layer base of src/styles/tailwind.css, which sets a 45px min-height, 5px
 * radius and 13px/14px padding on every input in the app. Tailwind emits
 * utilities after the base layer, so the classes below win without that rule
 * being edited and every other form keeping its current look.
 */

const EyeIcon = ({ off }) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {off ? (
      <>
        <path d="M2 12s3.6-6.5 10-6.5c1.4 0 2.7.3 3.8.8M22 12s-3.6 6.5-10 6.5c-1.4 0-2.7-.3-3.8-.8" />
        <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
        <path d="m3 3 18 18" />
      </>
    ) : (
      <>
        <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
        <circle cx="12" cy="12" r="2.75" />
      </>
    )}
  </svg>
);

export function AuthField({
  label,
  hint,
  error,
  /** Adds the show/hide control and manages the input's type. */
  revealable = false,
  /**
   * Ref onto the <input>. Passed explicitly rather than relying on React 19
   * treating `ref` as an ordinary prop inside the spread below, so the
   * behaviour does not depend on the React version.
   */
  inputRef,
  type = 'text',
  className = '',
  ...props
}) {
  const [revealed, setRevealed] = useState(false);
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  // The 2xl step matches the wider form container the auth screen gives this
  // field from 1536px up: at 520px wide, a 52px input starts to look short.
  const input =
    'h-[52px] 2xl:h-[58px] w-full rounded-[7px] border bg-white px-[15px] 2xl:px-[18px] py-0 '
    + 'font-manrope text-[15px] 2xl:text-[16px] text-auth-ink placeholder:text-auth-placeholder '
    + 'transition-[border-color,box-shadow] duration-200 '
    // Replaces the global :focus-visible outline (a 2px brown ring offset by
    // 5px) with the ink border and soft ring this design calls for. The border
    // colour change alone is the visible focus indicator; the ring reinforces it.
    + 'focus:border-auth-ink focus:ring-[3px] focus:ring-auth-ink/10 focus-visible:outline-none '
    + (error ? 'border-auth-error' : 'border-auth-border')
    + (revealable ? ' pr-[52px]' : '');

  return (
    <div className={className}>
      <label htmlFor={id} className="mb-2 block font-manrope text-[13px] font-semibold text-auth-ink 2xl:text-[14px]">
        {label}
      </label>

      <div className="relative">
        <input
          id={id}
          ref={inputRef}
          type={revealable ? (revealed ? 'text' : 'password') : type}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={input}
          {...props}
        />

        {revealable && (
          /* type="button" matters: inside a <form> a button defaults to
             submit, so without it toggling visibility would post the form.
             It carries no name attribute, so it never appears in the FormData
             the submit handler builds. */
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            aria-pressed={revealed}
            aria-label={revealed ? 'Hide password' : 'Show password'}
            className="absolute top-1/2 right-1 flex size-11 -translate-y-1/2 items-center justify-center rounded-[6px] text-auth-muted transition-colors duration-200 hover:text-auth-ink"
          >
            <EyeIcon off={revealed} />
          </button>
        )}
      </div>

      {hint && !error && (
        <p id={hintId} className="mt-2 mb-0 font-manrope text-[12px] leading-relaxed text-auth-muted">
          {hint}
        </p>
      )}

      {/* Error text, not just a red border: colour alone is not an accessible
          way to report a problem. */}
      {error && (
        <p id={errorId} className="mt-2 mb-0 font-manrope text-[12px] leading-relaxed text-auth-error">
          {error}
        </p>
      )}
    </div>
  );
}
