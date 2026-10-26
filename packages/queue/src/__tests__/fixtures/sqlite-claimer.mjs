// Worker thread for the SQLite concurrency test: one better-sqlite3
// connection per thread, so claims really race on the database file.
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

const { modulePath, file, queueName } = workerData;
const { DatabaseQueueAdapter, createSqliteQueueClient } = await import(modulePath);

const db = new Database(file);
db.pragma('busy_timeout = 30000');
const queue = new DatabaseQueueAdapter({ client: createSqliteQueueClient(db) });

parentPort.once('message', async () => {
  const acked = [];
  try {
    for (;;) {
      const job = await queue.claim(queueName, { leaseMs: 60_000 });
      if (!job) {
        break;
      }
      await queue.ack(job.id, { attempt: job.attempt });
      acked.push(job.id);
    }
    parentPort.postMessage({ acked });
  } catch (error) {
    parentPort.postMessage({ error: String(error?.stack ?? error) });
  } finally {
    db.close();
  }
});
parentPort.postMessage({ ready: true });
