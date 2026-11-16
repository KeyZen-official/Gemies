/*
  One pass of the job queue, then exit.

  server/worker.mjs is a long-lived process and server/index.mjs runs the same
  loop in-process on a timer. Neither survives on managed Node.js hosting,
  which has no place to run a second service and restarts the web process on
  every deployment, so a queue drained only by an in-process timer stalls
  whenever the app is idle or redeployed.

  This is the cron entry point for that environment: schedule it every few
  minutes with RUN_WORKER=false set on the web process, and the queue is
  drained by the scheduler instead of by a timer nobody keeps alive.

  Safe to overlap with any other worker. tick() claims each job with a single
  atomic findOneAndUpdate and a lease, so two runs cannot take the same job --
  see the header of server/jobs.mjs.
*/
import {connect, close, ensureSchema} from '../server/mongo.mjs';
import {tick} from '../server/jobs.mjs';

await connect();
await ensureSchema();
try {
  await tick();
} finally {
  // Always close, or a cron invocation that threw leaves its connection open
  // until the socket times out, and a frequent schedule then accumulates them
  // against the cluster's connection limit.
  await close();
}
