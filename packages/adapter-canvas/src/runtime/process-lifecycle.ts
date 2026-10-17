export interface ExtensionProcess {
  isShutDown(): boolean;
  shutdown(signal: string): Promise<void>;
}

export interface ProcessLifecyclePorts {
  extension: ExtensionProcess;
  onSignal(signal: string, handler: () => void): void;
  onUncaughtException(handler: (error: unknown) => void): void;
  onUnhandledRejection(handler: (reason: unknown) => void): void;
  setTimer(callback: () => void, milliseconds: number): NodeJS.Timeout;
  exit(code: number): void;
  log(message: string): void;
}

export interface ProcessLifecycle {
  gracefulShutdown(signal: string): Promise<void>;
  isShuttingDown(): boolean;
}

function errorDetail(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message;
  return String(value);
}

export function configureProcessLifecycle(
  ports: ProcessLifecyclePorts
): ProcessLifecycle {
  let gracefulShutdownStarted = false;

  const gracefulShutdown = async (signal: string): Promise<void> => {
    if (gracefulShutdownStarted) return;
    gracefulShutdownStarted = true;
    await ports.extension.shutdown(signal);
    ports.setTimer(() => ports.exit(0), 50);
  };

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    try {
      ports.onSignal(signal, () => {
        void gracefulShutdown(signal);
      });
    } catch {}
  }

  ports.onUncaughtException((error) => {
    try {
      ports.log(
        `[radius] uncaughtException (ignored to stay alive): ${errorDetail(error)}`
      );
    } catch {}
  });
  ports.onUnhandledRejection((reason) => {
    try {
      ports.log(
        `[radius] unhandledRejection (ignored to stay alive): ${errorDetail(reason)}`
      );
    } catch {}
  });

  return {
    gracefulShutdown,
    isShuttingDown: () => ports.extension.isShutDown()
  };
}

export function warmRadBinary(
  ensure: (options: { log(message: string): void }) => Promise<unknown>,
  log: (message: string) => void
): void {
  ensure({
    log: (message) => {
      try {
        log(`[radius] ${message}`);
      } catch {}
    }
  }).catch((error) => {
    try {
      log(
        `[radius] rad binary preparation failed (will retry on first use): ${errorDetail(error)}`
      );
    } catch {}
  });
}
