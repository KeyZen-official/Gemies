/*
  The production build, with NODE_ENV pinned.

  `next build` produces a production build by definition, but it still reads
  NODE_ENV from the environment and builds against whatever it finds. Build it
  with NODE_ENV=development and you get a mongrel: the production build
  pipeline wired to React's development build. Next.js says as much --
  "non-standard NODE_ENV ... creates inconsistencies" -- and then the build
  dies prerendering its own built-in global error page:

      Error occurred prerendering page "/_global-error"
      TypeError: Cannot read properties of null (reading 'useContext')

  which names neither NODE_ENV nor anything in this repository. The tell is the
  run of "Each child in a list should have a unique key prop" warnings just
  above it, pointing at <html>, <head> and <meta>: those warnings only exist in
  React's development build, so their presence during a production build is the
  evidence that NODE_ENV was wrong.

  A managed host supplies the environment from its own control panel, so the
  value is not under this repository's control at deploy time -- hence pinning
  it here, where it cannot be got wrong, rather than documenting it and hoping.

  --webpack is required separately: Next.js 16 builds with Turbopack by
  default, Turbopack needs the native SWC binary, and that binary needs a newer
  glibc than the host provides. Next.js falls back to its WebAssembly bindings,
  which webpack can use and Turbopack cannot. See docs/DEPLOY_HOSTINGER.md.
*/
import {spawn} from 'node:child_process';

const child = spawn(
  process.execPath,
  ['node_modules/next/dist/bin/next', 'build', '--webpack'],
  {stdio: 'inherit', env: {...process.env, NODE_ENV: 'production'}},
);

child.once('exit', (code, signal) => {
  // Preserve the distinction between a failed build and a killed one: a
  // signalled exit reports no code, and exiting 0 there would publish a build
  // that never finished.
  process.exit(code ?? (signal ? 1 : 0));
});
