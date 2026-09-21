/**
 * Imported bcrypt hashes are verified on worker threads, not the event loop.
 *
 * `bcryptjs` is pure JavaScript. Its async `compare` yields every 100 ms, but
 * a cost-12 compare still takes about 300 ms of main-thread CPU in three
 * blocking slices, so a spray of sign-in attempts against imported accounts
 * stalled every request for every tenant. argon2id verification never had the
 * problem because the `argon2` package is native and runs off the loop.
 *
 * A native bcrypt package would also fix it, but it changes the Docker build;
 * a small `worker_threads` pool running the same library does not.
 *
 * Design:
 *   - `min(2, availableParallelism())` workers, created lazily on the first
 *     bcrypt verify, so a deployment with no imported users never starts one.
 *   - One compare per worker at a time. Work beyond that waits in a FIFO queue
 *     of at most `MAX_QUEUED` jobs.
 *   - When the queue is full the verify is REFUSED with a 503, never answered.
 *     Answering `false` would tell a user with the right password it was
 *     wrong and count a brute-force failure against their account, so a spray
 *     could lock real users out; queuing without a bound turns the same spray
 *     into unbounded memory and latency. A 503 carries no verdict: it can
 *     never let a wrong password through, and it records no failure.
 *   - A worker that fails or exits mid-compare rejects that job with a 500
 *     for the same reason: no verdict was reached, so none is reported. The
 *     next job starts a replacement. The only way to get `true` out of this
 *     module is for bcrypt itself to return `true`.
 *   - Workers are `unref`'d while idle so an unclosed pool never keeps a
 *     process (or a vitest run) alive, and `shutdownBcryptPool` terminates
 *     them from the app's `onClose`.
 *
 * The worker body is an eval'd CommonJS string rather than a separate file.
 * The API runs as TypeScript under tsx in dev and under vitest, and as
 * compiled JS in the image; a worker FILE would need a different path and a
 * loader in each. The string needs neither: the only thing it loads is
 * `bcryptjs`, by an absolute path resolved here, from this module's location,
 * which is correct in all three. `execArgv: []` keeps the parent's flags out
 * of the worker: a flag like `--input-type=module` would otherwise turn the
 * CommonJS body into ESM with no `require`, and every compare would fail.
 */

import { availableParallelism } from 'node:os';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { RekeyError } from './error.js';

/**
 * Jobs allowed to wait for a free worker. At cost 12 one worker does about
 * three to five compares a second, so 32 queued jobs on a two-worker pool is
 * a worst case of roughly three to five seconds before a compare starts: long
 * enough to ride out a burst, short enough that a legitimate sign-in behind it
 * still lands inside a client's timeout. The memory held per job is a
 * password string and two callbacks.
 */
export const MAX_QUEUED = 32;

export const POOL_SIZE = Math.max(1, Math.min(2, availableParallelism()));

/** Jobs the pool accepts at once: one running per worker plus the queue. */
export const BCRYPT_POOL_CAPACITY = POOL_SIZE + MAX_QUEUED;

const RETRY_AFTER_SECONDS = 2;

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const bcrypt = require(workerData.bcryptPath);
parentPort.on('message', (job) => {
  let ok = false;
  try {
    ok = bcrypt.compareSync(job.plain, job.hash) === true;
  } catch {
    ok = false;
  }
  parentPort.postMessage(ok);
});
`;

interface Job {
  plain: string;
  hash: string;
  resolve: (ok: boolean) => void;
  reject: (err: RekeyError) => void;
}

interface Slot {
  worker: Worker;
  job: Job | null;
}

let bcryptPath: string | null = null;
const slots: Slot[] = [];
const queue: Job[] = [];

function resolveBcryptPath(): string {
  bcryptPath ??= createRequire(import.meta.url).resolve('bcryptjs');
  return bcryptPath;
}

/** The password was not checked: no verdict, and nothing to count. */
function noVerdict(cause: unknown): RekeyError {
  return new RekeyError({
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    message: 'The password check could not be completed.',
    fix: 'Retry. If it persists, the server log has the underlying worker error.',
    cause,
  });
}

function retire(slot: Slot, cause: unknown): void {
  const i = slots.indexOf(slot);
  if (i === -1) return;
  slots.splice(i, 1);
  const job = slot.job;
  slot.job = null;
  job?.reject(noVerdict(cause));
  pump();
}

function spawn(): Slot {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    execArgv: [],
    workerData: { bcryptPath: resolveBcryptPath() },
  });
  const slot: Slot = { worker, job: null };
  worker.unref();
  worker.on('message', (ok: unknown) => {
    const job = slot.job;
    slot.job = null;
    job?.resolve(ok === true);
    pump();
  });
  worker.on('error', (err) => {
    console.error('[bcrypt-pool] worker failed:', err instanceof Error ? err.message : String(err));
    retire(slot, err);
  });
  worker.on('exit', (code) => retire(slot, new Error(`bcrypt worker exited with code ${code}`)));
  slots.push(slot);
  return slot;
}

/** Hand queued jobs to idle workers, starting workers up to `POOL_SIZE`. */
function pump(): void {
  while (queue.length > 0) {
    const slot = slots.find((s) => s.job === null) ?? (slots.length < POOL_SIZE ? spawn() : null);
    if (!slot) break;
    const job = queue.shift()!;
    slot.job = job;
    slot.worker.ref();
    slot.worker.postMessage({ plain: job.plain, hash: job.hash });
  }
  for (const s of slots) if (s.job === null) s.worker.unref();
}

function inFlight(): number {
  return slots.reduce((n, s) => n + (s.job ? 1 : 0), 0) + queue.length;
}

/**
 * Compare a plaintext against a bcrypt hash on a worker thread.
 *
 * Resolves `true` only when bcrypt says so, `false` only when bcrypt says so.
 * Rejects with a RekeyError when no verdict was reached: 503
 * `PASSWORD_VERIFY_BUSY` when the pool is at capacity, 500 when a worker
 * failed. Callers must let either propagate rather than read it as a wrong
 * password.
 */
export function bcryptCompare(plain: string, hash: string): Promise<boolean> {
  if (inFlight() >= BCRYPT_POOL_CAPACITY) {
    return Promise.reject(
      new RekeyError({
        statusCode: 503,
        code: 'PASSWORD_VERIFY_BUSY',
        message: 'Too many password checks are waiting on this server, so this one was not attempted.',
        fix: 'Retry after the Retry-After interval. Nothing was counted against the account.',
        retryAfterSeconds: RETRY_AFTER_SECONDS,
      }),
    );
  }
  return new Promise<boolean>((resolve, reject) => {
    queue.push({ plain, hash, resolve, reject });
    pump();
  });
}

/** Workers currently alive. For tests and diagnostics. */
export function bcryptPoolWorkerCount(): number {
  return slots.length;
}

/**
 * Terminate every worker. Queued and running jobs reject without a verdict.
 * The pool starts again lazily on the next compare.
 */
export async function shutdownBcryptPool(): Promise<void> {
  const reason = new Error('bcrypt pool shut down');
  for (const job of queue.splice(0)) job.reject(noVerdict(reason));
  await Promise.all(slots.slice().map((s) => s.worker.terminate()));
}
