// Promotes a registered account to store administrator.
//
//   npm run admin -- you@example.com
//   npm run admin -- you@example.com --verify     (also marks the email verified)
//
// It says which problem you have. The original selected on
// `email=$1 AND verified=true` and threw one message for both failures, so
// "that account does not exist" and "that account exists but has not clicked
// its verification link" were indistinguishable -- and they need completely
// different fixes.
//
// This used to refuse to run while the dev server was up, because the embedded
// development database was a directory a single process owned and opening it
// from a second one corrupted it. MongoDB is a server that pools connections,
// so a second client is ordinary and the guard is gone.
import {connect, close, users, sessions} from '../server/mongo.mjs';

const args = process.argv.slice(2);
const address = args.find((a) => !a.startsWith('-'))?.trim().toLowerCase();
const alsoVerify = args.includes('--verify');

if (!address) {
  console.error('Usage: npm run admin -- registered-email@example.com [--verify]');
  process.exit(1);
}

await connect();
try {
  const user = await users().findOne({email: address});

  if (!user) {
    const count = await users().countDocuments({});
    console.error(`No account is registered with ${address}.`);
    console.error('');
    if (count === 0) {
      console.error('There are no user accounts at all yet. Start the app, open /register,');
      console.error('and create this account first.');
    } else {
      const others = await users()
        .find({}, {projection: {email: 1, verified: 1, role: 1}})
        .sort({created_at: -1}).limit(10).toArray();
      console.error(`${count} account(s) exist. The most recent:`);
      for (const o of others) {
        console.error(`  ${o.email.padEnd(36)} ${o.verified ? 'verified' : 'UNVERIFIED'}${o.role === 'admin' ? ' · admin' : ''}`);
      }
      console.error('');
      console.error('Register this address at /register, or re-run with one of the addresses above.');
    }
    process.exitCode = 1;
  } else if (user.role === 'admin') {
    console.log(`${user.email} is already an administrator${user.verified ? '' : ' (but still unverified)'}.`);
    if (!user.verified && alsoVerify) {
      await users().updateOne({_id: user._id}, {$set: {verified: true}});
      console.log('Email marked verified.');
    }
  } else if (!user.verified && !alsoVerify) {
    console.error(`${user.email} is registered but has not verified its email address.`);
    console.error('');
    console.error('Either click the verification link that was emailed to it, or re-run as:');
    console.error(`  npm run admin -- ${address} --verify`);
    console.error('');
    console.error('Verifying from here is safe: anyone who can run this script already has');
    console.error('database access, so the email check is not what protects the account.');
    process.exitCode = 1;
  } else {
    await users().updateOne({_id: user._id}, {$set: {role: 'admin', verified: true}});
    // The role is read from the database on every request, so an open session
    // picks this up without signing out. Sessions are dropped anyway, because
    // a privilege change is a good moment to require the password again.
    const dropped = await sessions().deleteMany({user_id: user._id});
    console.log(`${user.email} promoted to administrator${user.verified ? '' : ' and marked verified'}.`);
    if (dropped.deletedCount) console.log(`${dropped.deletedCount} existing session(s) ended.`);
    console.log('Sign in again, then open /admin.');
  }
} finally {
  await close();
}
