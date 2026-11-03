'use client';

/**
 * Section heading, replacing `.section-title` and `.section-title.split`.
 *
 * `centred` is the Just Dropped / Most Recommend treatment; `split` puts the
 * heading and copy on the left with an action on the right (New Era).
 */
export function SectionHeading({ heading, text, action, align = 'centred' }) {
  if (align === 'split') {
    return (
      <div className="mb-8 flex items-center justify-between gap-3 text-left md:items-end md:gap-6">
        <div>
          <h2 className="mb-3 text-xl font-semibold tracking-[-0.03em] md:text-2xl lg:text-[28px]">{heading}</h2>
          {text && <p className="m-0 text-[10px] leading-relaxed text-ink-soft md:text-xs lg:text-[13px]">{text}</p>}
        </div>
        {action}
      </div>
    );
  }

  return (
    <div className="mb-6 text-center md:mb-8">
      <h2 className="mb-3 text-[23px] leading-tight font-semibold tracking-[-0.03em] md:text-[27px] lg:text-[31px] xl:text-[34px]">
        {heading}
      </h2>
      {text && (
        <p className="mx-auto max-w-[62ch] text-[11px] leading-normal text-ink-soft md:text-xs lg:text-sm">{text}</p>
      )}
    </div>
  );
}
