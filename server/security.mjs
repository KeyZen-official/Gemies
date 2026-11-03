import {randomBytes,randomUUID,createHash,createHmac,timingSafeEqual,scrypt as scryptCallback} from 'node:crypto';
import {promisify} from 'node:util';
import {sessions,users,rateLimits,auditLogs,withSession} from './mongo.mjs';
import {config} from './config.mjs';
export const id=()=>randomUUID();
export const token=()=>randomBytes(32).toString('hex');
export const hash=value=>createHash('sha256').update(value).digest('hex');
export class HttpError extends Error {constructor(status,message){super(message);this.status=status;}}
export function assert(condition,status,message){if(!condition)throw new HttpError(status,message);}
const scrypt=promisify(scryptCallback);
export async function passwordHash(password){const salt=token();const key=await scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});return `${salt}:${key.toString('hex')}`;}
export async function passwordMatches(password,stored){const [salt,key]=stored.split(':');const derived=await scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});return equal(derived.toString('hex'),key);}
export function equal(a,b){return typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
export function validSignature(data,signature,secret){return !!secret&&equal(createHmac('sha256',secret).update(data).digest('hex'),signature);}

/**
 * Resolves the session cookie to a user.
 *
 * Was one SQL statement joining sessions to users. MongoDB has no joins in a
 * plain find, so this is two indexed lookups: the session by its token hash,
 * then its owner. Both are covered by unique or primary indexes, and the
 * expiry is checked in the query rather than afterwards so an expired session
 * cannot authenticate even for an instant.
 *
 * The shape it puts on `req.user` is unchanged: id, name, email, role,
 * verified and the session's csrf.
 */
export async function sessionMiddleware(req,res,next){
  const cookie=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('sid='))?.slice(4);
  if(cookie && /^[a-f0-9]{64}$/.test(cookie)){
    const tokenHash=hash(cookie);
    const session=await sessions().findOne(
      {token_hash:tokenHash,expires_at:{$gt:new Date()}},
      {projection:{user_id:1,csrf:1}},
    );
    if(session){
      const user=await users().findOne(
        {_id:session.user_id},
        {projection:{_id:1,id:1,name:1,email:1,role:1,verified:1}},
      );
      // A session whose user has been deleted authenticates nobody.
      if(user){req.user={id:user.id??user._id,name:user.name,email:user.email,role:user.role,verified:user.verified,csrf:session.csrf};req.sessionHash=tokenHash;}
    }
  }next();
}
export function csrfMiddleware(req,res,next){
  if(!['GET','HEAD','OPTIONS'].includes(req.method)){
    const origin=req.headers.origin;
    assert(origin===config.origin,403,'Request origin is not allowed.');
    if(req.user)assert(equal(req.headers['x-csrf-token'],req.user.csrf),403,'Session security token is missing. Refresh the page and try again.');
  }next();
}
export function auth(req,res,next){assert(req.user,401,'Please sign in to continue.');next();}
export function admin(req,res,next){assert(req.user?.role==='admin',403,'Administrator access is required.');next();}

export async function createSession(res,userId){
  const raw=token(),csrf=token();
  await sessions().insertOne({
    _id:hash(raw),
    // token_hash duplicates _id so the field name the queries use still exists.
    token_hash:hash(raw),
    user_id:userId,
    csrf,
    expires_at:new Date(Date.now()+7*86400000),
    created_at:new Date(),
  });
  res.cookie('sid',raw,{httpOnly:true,secure:config.production,sameSite:'lax',path:'/',maxAge:7*86400000});
  return csrf;
}

/**
 * Fixed-window rate limiting, per scope and IP.
 *
 * The SQL was a single atomic upsert whose ON CONFLICT branch used a CASE to
 * either reset the window or increment within it. The equivalent here is a
 * pipeline update, which MongoDB applies atomically against the stored
 * document, so two simultaneous requests cannot both read the same count and
 * each write back `hits + 1`.
 *
 * A plain `$inc` would have been wrong: it cannot reset the counter when the
 * window has elapsed, so a scope would be throttled forever once it was hit.
 */
export function limit(scope,max=10,seconds=900){return async(req,res,next)=>{
  const key=hash(`${scope}:${req.ip}`);
  const now=new Date();
  const fresh=new Date(now.getTime()+seconds*1000);
  const row=await rateLimits().findOneAndUpdate(
    {_id:key},
    [{
      $set:{
        key,
        hits:{$cond:[{$gt:[{$ifNull:['$expires_at',now]},now]},{$add:[{$ifNull:['$hits',0]},1]},1]},
        expires_at:{$cond:[{$gt:[{$ifNull:['$expires_at',now]},now]},{$ifNull:['$expires_at',fresh]},fresh]},
      },
    }],
    {upsert:true,returnDocument:'after'},
  );
  if(row.hits>max){res.set('Retry-After',String(seconds));throw new HttpError(429,'Too many requests. Please try again later.');}
  next();
};}

/**
 * Records an administrative action.
 *
 * Pass `session` to make the record atomic with the operation it describes, so
 * an admin action that rolls back cannot leave an audit entry claiming it
 * happened. Called without one -- for an action that is a single write anyway
 * -- it writes on its own.
 */
export const audit=async(actor,action,entity,session=undefined)=>{
  const row={_id:id(),actor_id:actor??null,action,entity_id:entity,created_at:new Date()};
  row.id=row._id;
  await auditLogs().insertOne(row,withSession(session));
  return row;
};
