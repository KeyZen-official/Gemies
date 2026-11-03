// Tailwind CSS v4 ships as a PostCSS plugin; Next.js picks this file up
// automatically. v4 needs no tailwind.config.js - the theme is declared in
// CSS via @theme, in src/styles/tailwind.css.
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
