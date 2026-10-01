export interface FitTarget {
  fitView(options: { padding: number }): Promise<boolean>;
}

// Fitting is presentation only: a viewport that refuses to fit must not take
// the graph down with it. React Flow v12's fitView is async, so a failure
// normally arrives as a rejection; the try/catch covers a synchronous throw.
export function requestFit(
  target: FitTarget | null,
  options: { padding: number }
): void {
  if (!target) return;
  let settled: Promise<boolean>;
  try {
    settled = target.fitView(options);
  } catch {
    return;
  }
  settled.catch(() => undefined);
}
