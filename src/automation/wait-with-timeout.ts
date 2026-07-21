const MAX_TIMER_DELAY_MS = 2_147_483_647;

export async function waitWithTimeout<T>(params: {
  work: Promise<T>;
  timeoutMs: number;
  createError: () => Error;
  abortSignal?: AbortSignal;
  createAbortError?: () => Error;
}): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    const timeoutMs = Math.max(0, params.timeoutMs);
    const deadline = Date.now() + timeoutMs;
    const scheduleNextChunk = () => {
      const remainingMs = Math.max(0, deadline - Date.now());
      if (remainingMs <= MAX_TIMER_DELAY_MS) {
        timeout = setTimeout(() => reject(params.createError()), remainingMs);
        return;
      }
      timeout = setTimeout(scheduleNextChunk, MAX_TIMER_DELAY_MS);
    };
    scheduleNextChunk();
  });
  const aborted = params.abortSignal
    ? new Promise<never>((_, reject) => {
        onAbort = () =>
          reject(
            params.createAbortError?.() ??
              (params.abortSignal?.reason instanceof Error
                ? params.abortSignal.reason
                : new Error("operation aborted")),
          );
        if (params.abortSignal?.aborted) {
          onAbort();
        } else {
          params.abortSignal?.addEventListener("abort", onAbort, { once: true });
        }
      })
    : undefined;
  try {
    return await Promise.race(aborted ? [params.work, timedOut, aborted] : [params.work, timedOut]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    if (onAbort) {
      params.abortSignal?.removeEventListener("abort", onAbort);
    }
  }
}
