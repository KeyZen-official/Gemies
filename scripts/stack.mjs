// Runs the Express API and the Next.js web server side by side.
//   node scripts/stack.mjs dev    -> API with --watch + next dev
//   node scripts/stack.mjs start  -> API + next start (requires npm run build)
// Next.js proxies /api and /uploads to the API, so both must be up.
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';

const mode = process.argv[2] === 'start' ? 'start' : 'dev';
const webPort = Number(process.env.WEB_PORT || 3000);
const apiPort = Number(process.env.PORT || 3001);
const nextBin = 'node_modules/next/dist/bin/next';

function portAvailable(port) {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

// Fail fast on a busy port. Without this the API loses the bind, --watch keeps
// retrying in silence, and the stack looks healthy while every request is
// served by a leftover process holding an older database directory. On Windows
// a force-killed `npm run dev` leaves exactly such an orphan behind, so stop
// the stack with Ctrl+C in its terminal.
for (const [port, role] of [[apiPort, 'API'], [webPort, 'web server']]) {
  if (await portAvailable(port)) continue;
  console.error(`Port ${port} is already in use, so the ${role} cannot start.`);
  console.error('Another dev stack is probably still running. Find it with:');
  console.error(`  Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object OwningProcess`);
  process.exit(1);
}

const children = [
  spawn(process.execPath, ['--env-file-if-exists=.env', ...(mode === 'dev' ? ['--watch'] : []), 'server/index.mjs'], {stdio: 'inherit'}),
  spawn(process.execPath, [nextBin, mode, '--port', String(webPort)], {stdio: 'inherit'}),
];

let closing = false;
const running = () => children.filter(child => child.exitCode === null && child.signalCode === null);

// Ctrl+C already reaches both children, because they share this console. The
// API needs that signal to run its own shutdown and close the embedded
// database; terminating it mid-write can leave .data/db unrecoverable. So wait
// for the children to finish instead of killing them, and only force the
// issue if one refuses to go.
function onSignal() {
  if (closing) return;
  closing = true;
  const force = setTimeout(() => {
    for (const child of running()) child.kill();
    process.exit(0);
  }, 10_000);
  force.unref();
  Promise.all(running().map(child => new Promise(resolve => child.once('exit', resolve))))
    .then(() => process.exit(0));
}

// One process down means the stack can no longer serve requests, so stop the
// rest rather than leaving a half-working site. In dev the API runs under
// --watch and stays alive after a crash, so this does not fight auto-reload.
function onChildExit(code) {
  if (closing) return;
  closing = true;
  for (const child of running()) child.kill();
  process.exit(code ?? 0);
}

for (const child of children) child.once('exit', onChildExit);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, onSignal);
