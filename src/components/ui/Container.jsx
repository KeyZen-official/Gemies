'use client';

/**
 * The one centred content container, now in Tailwind utilities.
 *
 * Replaces the `.container` rule that `.home-content`, `.page` and the footer
 * blocks used to compose. Width steps match the previous --page-pad values
 * (12px / 16px / 32px) and the cap is the --container-shell theme token.
 *
 * The navbar, hero and footer background stay outside this on purpose: they
 * are the full-bleed band.
 */
export function Container({ as: Tag = 'div', className = '', children, ...rest }) {
  return (
    <Tag
      className={`mx-auto w-[calc(100%-24px)] max-w-shell md:w-[calc(100%-32px)] lg:w-[calc(100%-64px)] ${className}`}
      {...rest}
    >
      {children}
    </Tag>
  );
}
