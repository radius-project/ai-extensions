import { dirname } from "node:path";

interface DevReloadWatcher {
  unref?(): void;
}

export interface DevReloadPorts {
  enabled: boolean;
  extensionPath: string;
  exists(path: string): boolean;
  fileSize(path: string): number;
  watchDirectory(
    path: string,
    listener: (filename: string | Buffer | null) => void
  ): DevReloadWatcher;
  isShuttingDown(): boolean;
  isDeploying(): boolean;
  getLastActivityAt(): number;
  now(): number;
  setTimer(callback: () => void, milliseconds: number): NodeJS.Timeout;
  clearTimer(timer: NodeJS.Timeout): void;
  log(message: string): void;
  shutdown(signal: string): void;
}

const RELOAD_IDLE_WINDOW_MS = 4000;
const RELOAD_DEFER_POLL_MS = 2000;
const RELOAD_MAX_DEFER_MS = 60000;

export function setupDevSelfReload(ports: DevReloadPorts): void {
  try {
    if (!ports.enabled) return;
    const extensionPath = ports.extensionPath;
    if (!extensionPath || !ports.exists(extensionPath)) return;

    let lastSize = -1;
    try {
      lastSize = ports.fileSize(extensionPath);
    } catch {}
    let debounce: NodeJS.Timeout | null = null;
    let triggered = false;
    let reloadPending = false;
    let reloadRequestedAt = 0;

    const reloadNow = () => {
      if (ports.isShuttingDown()) return;
      triggered = true;
      try {
        ports.log(
          "[radius][dev] extension.mjs changed — restarting for hot reload…"
        );
      } catch {}
      ports.setTimer(() => {
        ports.shutdown("DEV_RELOAD");
      }, 250);
    };

    const maybeReload = () => {
      if (triggered || ports.isShuttingDown()) return;
      const deploying = ports.isDeploying();
      const panelActive =
        ports.now() - ports.getLastActivityAt() < RELOAD_IDLE_WINDOW_MS;
      const waited = ports.now() - reloadRequestedAt;
      if (deploying || (panelActive && waited < RELOAD_MAX_DEFER_MS)) {
        try {
          ports.log(
            `[radius][dev] reload deferred (${deploying ? "deploy in flight" : "canvas panel active"}); retrying in ${RELOAD_DEFER_POLL_MS}ms…`
          );
        } catch {}
        ports.setTimer(maybeReload, RELOAD_DEFER_POLL_MS);
        return;
      }
      reloadNow();
    };

    const trigger = () => {
      if (triggered || ports.isShuttingDown()) return;
      let size = lastSize;
      try {
        size = ports.fileSize(extensionPath);
      } catch {}
      if (size === lastSize) return;
      lastSize = size;
      if (reloadPending) return;
      reloadPending = true;
      reloadRequestedAt = ports.now();
      maybeReload();
    };

    const watcher = ports.watchDirectory(dirname(extensionPath), (filename) => {
      if (filename && filename.toString() !== "extension.mjs") return;
      if (debounce) ports.clearTimer(debounce);
      debounce = ports.setTimer(trigger, 300);
    });
    try {
      watcher.unref?.();
    } catch {}
    try {
      ports.log(`[radius][dev] self-reload armed (watching ${extensionPath})`);
    } catch {}
  } catch (error) {
    try {
      ports.log(
        `[radius][dev] self-reload setup failed (ignored): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } catch {}
  }
}
