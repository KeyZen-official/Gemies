/**
 * An isolated MongoDB for tests.
 *
 * Starts a one-node in-memory replica set, which is what transactions need,
 * and points MONGODB_URI at it before server/mongo.mjs is imported. Tests
 * therefore never read or write the shared Atlas database -- a test suite that
 * truncated collections would otherwise destroy the development data.
 *
 * Import and await this BEFORE importing anything under server/.
 */
import {MongoMemoryReplSet} from 'mongodb-memory-server';

let replset = null;

export async function startMongo(dbName = 'gemies_test') {
  replset = await MongoMemoryReplSet.create({replSet: {count: 1}});
  process.env.MONGODB_URI = replset.getUri();
  process.env.MONGODB_DB_NAME = dbName;
  return process.env.MONGODB_URI;
}

export async function stopMongo() {
  if (replset) await replset.stop();
  replset = null;
}
