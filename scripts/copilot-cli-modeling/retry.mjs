// Retries with an injected clock, so tests can drive time.

export const systemClock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

/**
 * Calls `action` up to `attempts` times and returns its first result. Waits
 * `delayMs` times the attempt number between attempts, and throws the last
 * error. Use it only for steps that are safe to repeat.
 */
export async function retry(
  action,
  { attempts, delayMs, onRetry = () => {} },
  clock = systemClock
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= attempts) throw error;
      onRetry(error, attempt);
      await clock.sleep(delayMs * attempt);
    }
  }
}
