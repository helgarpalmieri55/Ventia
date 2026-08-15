import { describe, expect, it } from 'vitest';
import { createMutationQueue } from '../lib/mutation-queue';

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe('createMutationQueue', () => {
  it('resolves each task with its own result', async () => {
    const enqueue = createMutationQueue();
    await expect(enqueue(() => Promise.resolve('a'))).resolves.toBe('a');
    await expect(enqueue(() => Promise.resolve('b'))).resolves.toBe('b');
  });

  it('runs tasks strictly one at a time, in enqueue order — a slower earlier task never lets a later one start before it finishes', async () => {
    const events: string[] = [];

    const enqueue = createMutationQueue();
    const first = enqueue(async () => {
      events.push('first:start');
      await delay(30, undefined);
      events.push('first:end');
    });
    const second = enqueue(async () => {
      events.push('second:start');
      await delay(5, undefined);
      events.push('second:end');
    });

    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it("regression: the exact race a reviewer reproduced — a slow first request's response must not overwrite a fast second request's result", async () => {
    // Mirrors cart-context.tsx's real shape: each task calls a "server",
    // gets back a value, and applies it to shared state. Task A is slower
    // than task B despite being enqueued first — without serialization, A's
    // response would land after B's and stomp it (the reported bug: the
    // fast, later request's result got overwritten by the slow, earlier
    // one's). With the queue, B never even starts until A is fully done, so
    // there's no response ordering left to race on.
    let state = 0;
    const enqueue = createMutationQueue();

    const taskA = enqueue(async () => {
      const serverResponse = await delay(30, 2); // slow "PATCH qty=2"
      state = serverResponse;
    });
    const taskB = enqueue(async () => {
      const serverResponse = await delay(5, 5); // fast "PATCH qty=5", sent right after A
      state = serverResponse;
    });

    await Promise.all([taskA, taskB]);

    // B was enqueued after A, so it must win — state must reflect the LAST
    // enqueued mutation, not whichever happened to resolve first.
    expect(state).toBe(5);
  });

  it('a failed task does not poison the queue for tasks enqueued after it', async () => {
    const enqueue = createMutationQueue();

    await expect(enqueue(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(enqueue(() => Promise.resolve('still works'))).resolves.toBe('still works');
  });
});
