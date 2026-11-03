// Copy for the authentication screens, kept out of the component so wording
// can change without touching markup or form logic.
//
// One entry per mode of AuthPage. The six modes map to the six routes
// (/login, /register, /forgot, /reset, /verify, /resend), which all render the
// same component, so every mode needs an entry here or the page would render
// with an empty heading.
//
//   left   the promotional panel: a constant label, a heading and a sentence
//   right  the form side: eyebrow, heading and supporting line
//   submit the label on the submit button
//
// The promotional panel's garment is the same on every screen on purpose: it
// is the brand's own product shot, and swapping it per screen would make the
// set of auth pages look like separate designs.

/** Constant on every screen, above the promotional heading. */
export const promoLabel = 'YOUR EVERYDAY. REDEFINED.';

/**
 * The promotional panel photograph: an oversized black T-shirt on a warm cream
 * wall, with soft directional light and leaf shadows.
 *
 * Built from the supplied public/assets/loginImage.png by
 * scripts/build-auth-asset.mjs — 1.9 MB of PNG down to 55 KB of WebP, which
 * matters on the page people wait at before they can do anything.
 *
 * Unlike the product cutouts used elsewhere in the site, this is a full
 * photograph with its own background, so it is drawn `object-cover` and
 * full-bleed rather than `object-contain` on a flat colour. Containing it
 * would show the photo's edges as a pasted rectangle against the panel, since
 * its cream is close to but not the same as --color-auth-panel, and it carries
 * its own shadows.
 *
 * `focal` is the vertical object-position, and 75% is not a taste decision.
 *
 * The copy sits over the photograph's lower-left, so the region behind it has
 * to be the floor rather than the shirt: dark type on a black garment is
 * unreadable, and a scrim strong enough to fix that washes the garment out.
 *
 * Measured from the image, the shirt occupies 16%-70% of the source height.
 * Biasing the crop toward the bottom pushes the garment up the panel and
 * brings the floor into the text zone. The lowest value that clears the copy
 * at every breakpoint is ~0.69 (set by the short mobile band, which crops
 * hardest); 0.75 leaves a margin and still keeps the collar in frame on the
 * tall desktop column, where the window starts at 12.7%.
 *
 * Clearance at 0.75, computed from the compiled layout values:
 *   1440 split    shirt ends 557px, copy starts 598px   41px
 *    768 stacked  shirt ends 280px, copy starts 370px   90px
 *    390 stacked  shirt ends 186px, copy starts 206px   20px
 */
export const promoImage = {
  src: '/assets/login-panel.webp',
  width: 1024,
  height: 1536,
  focal: 'object-[50%_75%]',
};

export const authContent = {
  login: {
    left: {
      heading: 'Find Your Everyday Essentials.',
      text: 'Thoughtful fits. Better fabrics. Clothing made for everyday life.',
    },
    right: {
      eyebrow: 'GEMIES / YOUR ACCOUNT',
      heading: 'Welcome back',
      text: 'Your next favourite fit is waiting.',
    },
    submit: 'Sign in',
  },
  register: {
    left: {
      heading: 'Make Room for Better Style.',
      text: 'Create your account and discover everyday essentials designed around you.',
    },
    right: {
      eyebrow: 'GEMIES / JOIN THE COMMUNITY',
      heading: 'Create your account',
      text: 'Start building a wardrobe you’ll reach for every day.',
    },
    submit: 'Create account',
  },
  // The four screens below are not part of the redesign brief, but they render
  // through the same component, so they get the same composition and copy in
  // the same voice. Their form headings are unchanged from before.
  forgot: {
    left: {
      heading: 'Back to Your Everyday.',
      text: 'We’ll send a secure link so you can pick up where you left off.',
    },
    right: {
      eyebrow: 'GEMIES / ACCOUNT RECOVERY',
      heading: 'Forgot your password?',
      text: 'We’ll send you a link to get back in.',
    },
    submit: 'Send reset link',
  },
  reset: {
    left: {
      heading: 'A Fresh Start.',
      text: 'Choose a new password and your wardrobe is waiting where you left it.',
    },
    right: {
      eyebrow: 'GEMIES / ACCOUNT RECOVERY',
      heading: 'A fresh start',
      text: 'Choose a new, secure password.',
    },
    submit: 'Set new password',
  },
  verify: {
    left: {
      heading: 'One Step From Your Wardrobe.',
      text: 'Confirm your email address and your account is ready to use.',
    },
    right: {
      eyebrow: 'GEMIES / EMAIL VERIFICATION',
      heading: 'Verify your email',
      text: 'Confirm your address to unlock your account.',
    },
    submit: 'Verify email',
  },
  resend: {
    left: {
      heading: 'Let’s Try That Again.',
      text: 'We’ll send a fresh verification link straight to your inbox.',
    },
    right: {
      eyebrow: 'GEMIES / EMAIL VERIFICATION',
      heading: 'Check your inbox',
      text: 'Request a new verification link.',
    },
    submit: 'Send verification email',
  },
};
