import { redactCredentials } from "@radius-project/core";
import type { SessionPort } from "./session.js";
import { errorMessage } from "./util.js";

export interface PluginUpdatePort {
  list(): Promise<{
    plugins: Array<{
      name: string;
      marketplace: string;
      enabled: boolean;
      installedFrom?: string;
      source?: string;
      managed?: boolean;
    }>;
  }>;
  update(input: { name: string }): Promise<{
    previousVersion?: string;
    newVersion?: string;
    skillsInstalled: number;
  }>;
}

export function automaticPluginUpdatesEnabled(environment: {
  COPILOT_AUTO_UPDATE?: string;
  CI?: string;
}): boolean {
  return (
    environment.COPILOT_AUTO_UPDATE?.trim().toLowerCase() !== "false" &&
    !environment.CI
  );
}

export function createRadiusPluginUpdater(options: {
  enabled: boolean;
  isShutDown(): boolean;
  logError(message: string): void;
}): (session: SessionPort) => Promise<void> {
  let pending: Promise<void> | undefined;

  async function update(session: SessionPort): Promise<void> {
    if (!options.enabled || options.isShutDown()) return;
    try {
      const plugins = session.rpc.plugins;
      if (!plugins) {
        throw new Error(
          "This Copilot runtime does not support session plugin updates."
        );
      }
      const installed = await plugins.list();
      if (options.isShutDown()) return;
      const candidates = installed.plugins.filter(
        (plugin) => plugin.name === "radius" && plugin.enabled
      );
      // Never choose between same-named sources or update a local/managed copy.
      if (candidates.length !== 1) return;
      const plugin = candidates[0];
      if (
        !plugin.marketplace ||
        plugin.installedFrom ||
        plugin.source === "builtin" ||
        plugin.managed
      ) {
        return;
      }
      const ui = session.ui;
      if (session.capabilities?.ui?.elicitation !== true || !ui?.confirm) {
        throw new Error(
          "This Copilot host does not support interactive plugin update approval. No update was installed."
        );
      }
      const approved = await ui.confirm(
        `Update radius@${plugin.marketplace} to the latest version available from this marketplace? Installed changes will load in a new session; this session keeps its current code.`
      );
      if (options.isShutDown() || approved !== true) return;
      await plugins.update({
        name: `${plugin.name}@${plugin.marketplace}`
      });
      if (options.isShutDown()) return;
      await session.log?.(
        "Radius plugin update check completed. Start a new session to load any installed changes; this session keeps its current code.",
        { level: "info", ephemeral: true }
      );
    } catch (error) {
      if (options.isShutDown()) return;
      const message = redactCredentials(
        `Radius could not complete its plugin update: ${errorMessage(error)} Use Customize > Installed to update Radius manually. This session keeps its current code.`
      );
      options.logError(message);
      if (session.log) {
        try {
          await session.log(message, { level: "warning", ephemeral: true });
        } catch (logError) {
          if (options.isShutDown()) return;
          options.logError(
            redactCredentials(
              `Radius could not display its plugin update notice: ${errorMessage(logError)}`
            )
          );
        }
      }
    }
  }

  return (session) => {
    pending ??= update(session);
    return pending;
  };
}
