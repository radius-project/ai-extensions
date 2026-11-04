// Stages the locally built Radius plugin as a one-plugin local marketplace.
//
// Copilot installs plugins from marketplaces. A direct install from a path
// still works, but Copilot reports it as deprecated. A local marketplace
// directory that holds the built plugin uses the supported path and installs
// the code under test, not the published `radius@edge` build.

import fs from "node:fs/promises";
import path from "node:path";

import { isJsonObject, parseJson } from "./json.mjs";

export const MARKETPLACE_NAME = "radius-ci";
export const PLUGIN_NAME = "radius";

/** The source that `copilot plugin install` takes: `<plugin>@<marketplace>`. */
export const PLUGIN_SOURCE = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

/** The `.github/plugin/marketplace.json` document. */
export function marketplaceManifest() {
  return {
    name: MARKETPLACE_NAME,
    owner: { name: "Radius CI" },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: `./${PLUGIN_NAME}`,
        description: "Radius plugin built from this checkout"
      }
    ]
  };
}

/**
 * Copies the built plugin into `marketplaceDir/radius` and writes the
 * manifest. Fails if the build output is missing or names another plugin.
 */
export async function stageMarketplace({ pluginDir, marketplaceDir }) {
  const pluginJson = path.join(pluginDir, "plugin.json");

  let text;

  try {
    text = await fs.readFile(pluginJson, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT")
      throw new Error(
        `The built plugin is missing at ${pluginJson}. Run "pnpm build" first.`,
        { cause: error }
      );

    throw error;
  }
  const manifest = parseJson(text);

  if (!isJsonObject(manifest))
    throw new Error(`${pluginJson} is not a JSON object.`);

  if (manifest.name !== PLUGIN_NAME)
    throw new Error(
      `${pluginJson} names plugin "${String(manifest.name)}", not "${PLUGIN_NAME}".`
    );
  await fs.rm(marketplaceDir, { recursive: true, force: true });
  await fs.cp(pluginDir, path.join(marketplaceDir, PLUGIN_NAME), {
    recursive: true
  });
  const manifestDir = path.join(marketplaceDir, ".github", "plugin");
  await fs.mkdir(manifestDir, { recursive: true });
  await fs.writeFile(
    path.join(manifestDir, "marketplace.json"),
    `${JSON.stringify(marketplaceManifest(), null, 2)}\n`
  );
}
