import {app,serveWeb} from './app.mjs';
import {config} from './config.mjs';
import {startWorker} from './jobs.mjs';
import {connect as connectMongo,close as closeMongo,ensureSchema,users,sessions} from './mongo.mjs';
// Nothing can serve a request until MongoDB is connected and indexed.
// ensureSchema creates every index and seeds the settings singleton, and is
// idempotent, so it runs on every boot in place of a migration step. There is
// no second database: PostgreSQL and its migrations are gone.
await connectMongo();
await ensureSchema();

/*
  Optional development convenience: BOOTSTRAP_ADMIN_EMAIL promotes a registered
  account to administrator as the server starts.

  This originally had to happen here rather than in `npm run admin`, because
  that script opened a second connection to the embedded development database,
  which allowed only one process and was corrupted by the attempt more than
  once. That constraint is gone, so `npm run admin` does the same job; this
  stays because it is one fewer step on a fresh machine.

  Idempotent, and refuses to run in production.
*/
if(!config.production&&process.env.BOOTSTRAP_ADMIN_EMAIL){
  const address=process.env.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase();
  const user=await users().findOne({email:address},{projection:{role:1,verified:1}});
  if(!user)console.log(`BOOTSTRAP_ADMIN_EMAIL is ${address}, which is not registered yet. Create it at /register, then restart.`);
  else if(user.role==='admin'&&user.verified)console.log(`${address} is already a verified administrator.`);
  else{
    await users().updateOne({_id:user._id},{$set:{role:'admin',verified:true}});
    // Any open session re-reads the role on its next request, but ending them
    // makes the privilege change explicit.
    await sessions().deleteMany({user_id:user._id});
    console.log(`Promoted ${address} to administrator.`);
  }
}
/*
  Which interface to bind.

  Production binds every interface. A managed host or a reverse proxy reaches
  this process from another address on the machine, and a socket bound to
  loopback refuses that connection, which presents as a 502 with the app
  apparently healthy in its own logs. Development stays on loopback so a dev
  server is never exposed to the local network. HOST overrides both.
*/
const host=process.env.HOST||(config.production?'0.0.0.0':'127.0.0.1');

/*
  The storefront, in this same process.

  Managed Node.js hosting runs one process per site on one assigned port, and
  will not let the app open a port of its own, so the two-process topology --
  Next.js on 3000 proxying /api to Express on 3001 -- cannot be deployed there.
  Attaching the Next.js request handler to the Express app removes the need
  for the proxy entirely: same origin, same port, no rewrite, so the session
  cookie and the Origin-based CSRF check keep working as they did.

  SERVE_WEB=false, or the --api-only argument, keeps this process API-only.
  That is the split topology: what scripts/stack.mjs runs in development, where
  next dev owns hot reloading, and what a VPS wants if it runs the API and the
  web server as separate units behind its own proxy. The argument exists
  because an npm script cannot set an environment variable in a way that works
  on both PowerShell and a POSIX shell.

  next() is imported dynamically so an API-only process never loads the
  framework, and dev mode is taken from NODE_ENV: in production it serves the
  output of `next build` and fails loudly here if that build is missing,
  rather than at the first request.
*/
const apiOnly=process.argv.includes('--api-only')||process.env.SERVE_WEB==='false';
if(!apiOnly){
  // src/api-origin.js builds the loopback origin for server-side reads out of
  // PORT. Publish the port this process actually bound, so the two cannot
  // disagree when PORT was left unset and each fell back to its own default.
  // config.port is the single source of truth either way.
  process.env.PORT=String(config.port);
  const {default:next}=await import('next');
  const web=next({dev:!config.production,dir:process.cwd(),hostname:host,port:config.port});
  await web.prepare();
  serveWeb(web.getRequestHandler());
}

const timer=process.env.RUN_WORKER==='false'?null:startWorker();
const role=apiOnly?'API':'app';
const server=app.listen(config.port,host,()=>console.log(`Gemies ${role} listening on ${host}:${config.port}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(timer)clearInterval(timer);server.close(async()=>{await closeMongo();process.exit(0);});});
