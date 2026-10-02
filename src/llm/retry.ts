import { TransientModelError } from "./types.js";

export interface RetryOptions {
  maxRetries: number; // 3 per the implementation plan
  baseDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retries only TransientModelError, with exponential backoff and jitter. */
export async function withRetries<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<{ value: T; retries: number }> {
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return { value: await fn(), retries: attempt };
    } catch (err) {
      if (!(err instanceof TransientModelError) || attempt >= opts.maxRetries) {
        if (err instanceof Error) Object.assign(err, { retries: attempt });
        throw err;
      }
      const delay = opts.baseDelayMs * 2 ** attempt * (0.5 + Math.random() / 2);
      await sleep(delay);
    }
  }
}
