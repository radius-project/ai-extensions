import { redactCredentials } from "@radius-project/core";
import type { SessionPluginsPort, SessionPort } from "./session.js";
import type { PluginUpdatePreferences } from "./plugin-update-preferences.js";
import { errorMessage } from "./util.js";

function environmentFlag(value: string | undefined, defaultValue: boolean) {
  const normalized = value?.trim().toLowerCase();
  return normalized ?
      normalized !== "false" && normalized !== "0"
    : defaultValue;
}

export function automaticPluginUpdatesEnabled(environment: {
  COPILOT_AUTO_UPDATE?: string;
  CI?: string;
}): boolean {
  return (
    environmentFlag(environment.COPILOT_AUTO_UPDATE, true) &&
    !environmentFlag(environment.CI, false)
  );
}

export function createRadiusPluginUpdater(options: {
  enabled: boolean;
  preferences: PluginUpdatePreferences;
  isShutDown(): boolean;
  logError(message: string): void;
}): (session: SessionPort) => Promise<void> {
  let pending: Promise<void> | undefined;

  async function update(session: SessionPort): Promise<void> {
    if (!options.enabled || options.isShutDown()) return;
    const plugins = session.rpc.plugins;
    if (!plugins) {
      options.logError(
        "Radius skipped its plugin update request: this runtime does not support session plugin updates."
      );
      return;
    }
    const ui = session.ui;
    if (session.capabilities?.ui?.elicitation !== true || !ui?.confirm) {
      options.logError(
        "Radius skipped its plugin update request: this host does not support interactive approval."
      );
      return;
    }
    let result: Awaited<ReturnType<SessionPluginsPort["update"]>>;
    try {
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
      const version = plugin.version?.trim();
      if (!version) {
        options.logError(
          "Radius skipped its plugin update request: the installed version is unavailable, so a decline cannot be remembered safely."
        );
        return;
      }
      const identity = { marketplace: plugin.marketplace, version };
      const declined = await options.preferences.hasDeclined(identity);
      if (options.isShutDown() || declined) return;
      const approved = await ui.confirm(
        `Update radius@${plugin.marketplace} to the latest version available from this marketplace? Installed changes will load in a new session; this session keeps its current code. If you decline or cancel, Radius will not ask again for this installed version and marketplace.`
      );
      if (options.isShutDown()) return;
      if (approved !== true) {
        await options.preferences.rememberDecline(identity);
        return;
      }
      result = await plugins.update({
        name: `${plugin.name}@${plugin.marketplace}`
      });
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
      return;
    }
    if (options.isShutDown()) return;
    try {
      await session.log?.(updateNotice(result), {
        level: "info",
        ephemeral: true
      });
    } catch (error) {
      if (options.isShutDown()) return;
      options.logError(
        redactCredentials(
          `Radius could not display its completed plugin update notice: ${errorMessage(error)}`
        )
      );
    }
  }

  return (session) => {
    pending ??= update(session);
    return pending;
  };
}

function updateNotice(
  result: Awaited<ReturnType<SessionPluginsPort["update"]>>
): string {
  const nextSession =
    "Start a new session to load installed changes; this session keeps its current code.";
  if (result.newVersion) {
    if (result.previousVersion === result.newVersion) {
      return `Radius is already up to date (${result.newVersion}).`;
    }
    if (result.previousVersion) {
      return `Updated Radius from ${result.previousVersion} to ${result.newVersion}. ${nextSession}`;
    }
    return `Updated Radius to ${result.newVersion}. ${nextSession}`;
  }
  return `Radius plugin update completed. ${nextSession}`;
}
