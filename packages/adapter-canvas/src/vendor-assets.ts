import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

export interface VendorAssets {
  readonly react: string;
  readonly reactDom: string;
  readonly reactFlow: string;
  readonly dagre: string;
  readonly reactFlowCss: string;
}

const require = createRequire(import.meta.url);

const assetSpecifiers = {
  react: "react/umd/react.production.min.js",
  reactDom: "react-dom/umd/react-dom.production.min.js",
  reactFlow: "reactflow/dist/umd/index.js",
  dagre: "dagre/dist/dagre.min.js",
  reactFlowCss: "reactflow/dist/style.css"
} as const;

function packageRoot(name: string): string {
  let current = dirname(require.resolve(name));
  while (!existsSync(join(current, "package.json"))) {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Unable to locate package root for "${name}".`);
    }
    current = parent;
  }
  return current;
}

function readAsset(name: keyof typeof assetSpecifiers): string {
  const specifier = assetSpecifiers[name];
  const packageName = specifier.split("/")[0];
  const relativePath = specifier.slice(packageName.length + 1);
  let path: string;
  try {
    path = join(packageRoot(packageName), relativePath);
  } catch (error) {
    throw new Error(
      `Missing required Radius Canvas vendor asset "${specifier}". ` +
        "Install the pinned canvas dependencies before building.",
      { cause: error }
    );
  }

  try {
    if (!existsSync(path)) {
      throw new Error("file does not exist");
    }
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read required Radius Canvas vendor asset "${specifier}" at "${path}".`,
      { cause: error }
    );
  }
}

export function readVendorAssets(): VendorAssets {
  return {
    react: readAsset("react"),
    reactDom: readAsset("reactDom"),
    reactFlow: readAsset("reactFlow"),
    dagre: readAsset("dagre"),
    reactFlowCss: readAsset("reactFlowCss")
  };
}
