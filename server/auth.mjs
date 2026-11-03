import {Router} from 'express';
import {z} from 'zod';
import {users,sessions,authTokens,addresses,transaction} from './mongo.mjs';
import {id,token,hash,passwordHash,passwordMatches,createSession,auth,limit,assert} from './security.mjs';
import {email,password,addressSchema} from './validation.mjs';
import {queueEmail} from './queue.mjs';
import {config} from './config.mjs';
export const authRoutes=Router();

/** MongoDB's duplicate-key error. */
const DUPLICATE=11000;
const isDuplicate=(error)=>error?.code===DUPLICATE;

/**
 * Issues a one-hour, single-use token and queues the email that carries it.
 *
 * Only the hash is stored; the raw token exists in the job payload because the
 * link needs it, and jobs.mjs wipes an email payload the moment the send
 * succeeds. A permanently failed job keeps its payload, but the token in it has
 * expired long before the retry ladder runs out.
 *
 * The dedupe key is derived from the token hash, so each request produces its
 * own key. Resending is throttled by the route rate limits, not by dedupe,
 * which is deliberate: a customer who lost the first email must be able to ask
 * for another.
 *
 * Replacing the previous token and queueing the mail stay in one transaction,
 * so a customer never ends up with an email whose token was never stored.
 */
async function sendToken(user,kind){
  const raw=token();
  await transaction(async(session)=>{
    await authTokens().deleteMany({user_id:user.id,kind},{session});
    await authTokens().insertOne({
      _id:hash(raw),
      token_hash:hash(raw),
      user_id:user.id,
      kind,
      expires_at:new Date(Date.now()+3600000),
      created_at:new Date(),
    },{session});
    await queueEmail(
      `${kind}:${hash(raw)}`,
      user.email,
      kind==='verify'?'Confirm your GEMIES email address':'Reset your GEMIES password',
      {template:kind,userId:user.id,data:{url:`${config.origin}/${kind}?token=${raw}`}},
      session,
    );
  });
}

authRoutes.get('/session',(req,res)=>res.json({user:req.user||null}));

/**
 * Registration.
 *
 * `INSERT ... ON CONFLICT(email) DO NOTHING RETURNING` becomes an insert whose
 * duplicate-key error is caught. The unique index on `email` is what enforces
 * it, so two simultaneous registrations for one address still produce exactly
 * one account and only one of them sends the welcome mail.
 */
authRoutes.post('/register',limit('register',5),async(req,res)=>{
  const v=z.object({name:z.string().trim().min(2).max(100),email,password}).strict().parse(req.body);
  const userId=id();
  const pw=await passwordHash(v.password);
  let created=null;
  try{
    const doc={
      _id:userId,
      id:userId,
      name:v.name,
      email:v.email,
      password_hash:pw,
      role:'customer',
      verified:false,
      created_at:new Date(),
    };
    await users().insertOne(doc);
    created={id:userId,email:v.email,name:v.name};
  }catch(error){
    if(!isDuplicate(error))throw error;
  }
  if(created){
    await sendToken(created,'verify');
    // Welcome is separate from verification on purpose: verification is the
    // action the customer has to take, and burying it under brand copy costs
    // conversions. Keyed on the user id, so it can only ever be sent once.
    await queueEmail(`welcome:${created.id}`,created.email,'Welcome to GEMIES',{template:'welcome',userId:created.id,data:{name:created.name}});
  }
  // The response is identical whether or not the address was new, so the
  // endpoint cannot be used to discover which addresses are registered.
  res.status(202).json({message:'If this address is new, a verification email is queued. Check your inbox before signing in.'});
});

const dummyHash=await passwordHash('not-a-user-password-for-timing');

authRoutes.post('/login',limit('login',12),async(req,res)=>{
  const v=z.object({email,password:z.string().min(1).max(128)}).strict().parse(req.body);
  const u=await users().findOne({email:v.email});
  // The dummy hash keeps the response time of an unknown address the same as a
  // wrong password, so the endpoint does not leak which addresses exist.
  const matches=await passwordMatches(v.password,u?.password_hash||dummyHash);
  assert(u&&matches,401,'Email or password is incorrect.');
  assert(u.verified,403,'Verify your email before signing in.');
  if(req.sessionHash)await sessions().deleteOne({token_hash:req.sessionHash});
  const csrf=await createSession(res,u.id??u._id);
  res.json({user:{id:u.id??u._id,name:u.name,email:u.email,role:u.role,verified:u.verified,csrf}});
});

authRoutes.post('/logout',auth,async(req,res)=>{
  await sessions().deleteOne({token_hash:req.sessionHash});
  res.clearCookie('sid',{path:'/'});
  res.json({ok:true});
});

authRoutes.post('/forgot',limit('forgot',5),async(req,res)=>{
  const value=email.parse(req.body.email);
  const u=await users().findOne({email:value},{projection:{_id:1,id:1,email:1}});
  if(u)await sendToken({id:u.id??u._id,email:u.email},'reset');
  res.json({message:'If the account exists, a reset email is queued.'});
});

authRoutes.post('/resend',limit('verify-resend',5),async(req,res)=>{
  const value=email.parse(req.body.email);
  const u=await users().findOne({email:value,verified:false},{projection:{_id:1,id:1,email:1}});
  if(u)await sendToken({id:u.id??u._id,email:u.email},'verify');
  res.json({message:'If verification is needed, an email is queued.'});
});

/**
 * Email verification.
 *
 * `DELETE ... RETURNING user_id` becomes `findOneAndDelete`, which is atomic:
 * two simultaneous submissions of the same link mean only one of them gets the
 * document back, so the token really is single-use. The expiry is part of the
 * filter rather than checked afterwards, so an expired link is never consumed.
 */
authRoutes.post('/verify',limit('verify',20),async(req,res)=>{
  const raw=z.string().regex(/^[a-f0-9]{64}$/).parse(req.body.token);
  await transaction(async(session)=>{
    const t=await authTokens().findOneAndDelete(
      {token_hash:hash(raw),kind:'verify',expires_at:{$gt:new Date()}},
      {session},
    );
    assert(t,400,'This verification link has expired or was already used.');
    await users().updateOne({_id:t.user_id},{$set:{verified:true}},{session});
  });
  res.json({message:'Email verified. You can now sign in.'});
});

authRoutes.post('/reset',limit('reset',10),async(req,res)=>{
  const v=z.object({token:z.string().regex(/^[a-f0-9]{64}$/),password}).strict().parse(req.body);
  const pw=await passwordHash(v.password);
  await transaction(async(session)=>{
    const t=await authTokens().findOneAndDelete(
      {token_hash:hash(v.token),kind:'reset',expires_at:{$gt:new Date()}},
      {session},
    );
    assert(t,400,'This reset link has expired or was already used.');
    await users().updateOne({_id:t.user_id},{$set:{password_hash:pw}},{session});
    await sessions().deleteMany({user_id:t.user_id},{session});
    // A completed reset is a password change, and is worth telling the account
    // owner about: if they did not do it, this is how they find out.
    const owner=await users().findOne({_id:t.user_id},{projection:{email:1},session});
    if(owner)await queueEmail(`password-changed:${hash(pw)}`,owner.email,'Your GEMIES password was changed',{template:'password_changed',userId:t.user_id,data:{when:new Date().toISOString().replace('T',' ').slice(0,16)+' UTC'}},session);
  });
  res.clearCookie('sid',{path:'/'}).json({message:'Password reset. Sign in with your new password.'});
});

authRoutes.patch('/profile',auth,async(req,res)=>{
  const name=z.string().trim().min(2).max(100).parse(req.body.name);
  await users().updateOne({_id:req.user.id},{$set:{name}});
  res.json({ok:true});
});

authRoutes.post('/password',auth,limit('password',5),async(req,res)=>{
  const v=z.object({current:z.string().min(1).max(128),password}).strict().parse(req.body);
  const u=await users().findOne({_id:req.user.id},{projection:{password_hash:1}});
  assert(await passwordMatches(v.current,u.password_hash),400,'Current password is incorrect.');
  const pw=await passwordHash(v.password);
  // The confirmation is queued inside the same transaction as the change, so a
  // customer is never told their password changed when it did not.
  //
  // The key includes the new hash, which makes it unique per change while
  // revealing nothing: it is a scrypt hash of the password, never the password.
  await transaction(async(session)=>{
    await users().updateOne({_id:req.user.id},{$set:{password_hash:pw}},{session});
    await sessions().deleteMany({user_id:req.user.id},{session});
    await queueEmail(`password-changed:${hash(pw)}`,req.user.email,'Your GEMIES password was changed',{template:'password_changed',userId:req.user.id,data:{when:new Date().toISOString().replace('T',' ').slice(0,16)+' UTC'}},session);
  });
  res.clearCookie('sid',{path:'/'}).json({message:'Password updated. Please sign in again.'});
});

authRoutes.get('/addresses',auth,async(req,res)=>res.json(await addresses().find({user_id:req.user.id}).toArray()));

authRoutes.post('/addresses',auth,async(req,res)=>{
  const details=addressSchema.parse(req.body);
  const n=await addresses().countDocuments({user_id:req.user.id});
  assert(n<20,400,'You can save up to 20 addresses.');
  const addressId=id();
  await addresses().insertOne({_id:addressId,id:addressId,user_id:req.user.id,details,created_at:new Date()});
  res.status(201).json({ok:true});
});

authRoutes.delete('/addresses/:id',auth,async(req,res)=>{
  await addresses().deleteOne({_id:req.params.id,user_id:req.user.id});
  res.json({ok:true});
});
