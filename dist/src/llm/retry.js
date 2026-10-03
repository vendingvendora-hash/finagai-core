import { TransientModelError } from "./types.js";
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Retries only TransientModelError, with exponential backoff and jitter. */
export async function withRetries(fn, opts) {
    const sleep = opts.sleep ?? defaultSleep;
    for (let attempt = 0;; attempt++) {
        try {
            return { value: await fn(), retries: attempt };
        }
        catch (err) {
            if (!(err instanceof TransientModelError) || attempt >= opts.maxRetries) {
                if (err instanceof Error)
                    Object.assign(err, { retries: attempt });
                throw err;
            }
            const delay = opts.baseDelayMs * 2 ** attempt * (0.5 + Math.random() / 2);
            await sleep(delay);
        }
    }
}
//# sourceMappingURL=retry.js.map