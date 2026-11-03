import {app} from './app.mjs';
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
const timer=process.env.RUN_WORKER==='false'?null:startWorker();
const server=app.listen(config.port,process.env.HOST||'127.0.0.1',()=>console.log(`Gemies API: http://localhost:${config.port}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(timer)clearInterval(timer);server.close(async()=>{await closeMongo();process.exit(0);});});
