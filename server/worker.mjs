// The background worker as its own process.
//
// Running it separately used to require PostgreSQL, because the embedded
// development database allowed only one process and a second worker would have
// corrupted it. MongoDB is a server, so this is now a supported way to run in
// any environment: the job claim is a single atomic findOneAndUpdate with a
// lease, so any number of workers can share one queue without handing the same
// job to two of them. See the note at the top of jobs.mjs.
//
// The API process also runs a worker unless RUN_WORKER=false, so set that when
// running this one alongside it.
import {connect, close, ensureSchema} from './mongo.mjs';
import {tick} from './jobs.mjs';

await connect();
await ensureSchema();
console.log('Gemies worker started');
const timer = setInterval(tick, 5000);
await tick();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    clearInterval(timer);
    await close();
    process.exit(0);
  });
}
