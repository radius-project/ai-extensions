export interface SetupVerificationObservation {
  state: string;
  terminal?: boolean;
  error?: string;
}

export interface SetupVerificationMonitorOperation {
  active: boolean;
  stopRequested: boolean;
}

export interface SetupVerificationMonitorPorts {
  current(): SetupVerificationMonitorOperation | undefined;
  observe(): Promise<SetupVerificationObservation>;
  stop(): Promise<void>;
  expire(message: string): Promise<void>;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  jitter(): number;
}

export async function monitorSetupVerification(
  deadline: number,
  ports: SetupVerificationMonitorPorts
): Promise<void> {
  let delay = 5000;
  while (ports.now() < deadline) {
    const operation = ports.current();
    if (!operation?.active) return;
    if (operation.stopRequested) {
      await ports.stop();
      return;
    }
    const result = await ports.observe();
    if (result.state === "success" || result.state === "failed") return;
    if (result.terminal || result.state === "expired") {
      if (ports.current()?.active) {
        await ports.expire(
          result.error || "Credential verification is no longer being tracked."
        );
      }
      return;
    }
    await ports.sleep(Math.min(delay, 15_000) + ports.jitter());
    delay = Math.min(Math.ceil(delay * 1.5), 15_000);
  }
  throw new Error(
    "Credential verification did not complete within 45 minutes."
  );
}
