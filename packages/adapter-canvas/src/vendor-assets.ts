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

export interface VendorAssetReader {
  resolvePackage(name: string): string;
  exists(path: string): boolean;
  read(path: string): string;
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
      // v8 ignore next -- require.resolve always starts inside an installed package tree.
      throw new Error(`Unable to locate package root for "${name}".`);
    }
    current = parent;
  }
  return current;
}

const defaultReader: VendorAssetReader = {
  resolvePackage: (name) => packageRoot(name),
  exists: existsSync,
  read: (path) => readFileSync(path, "utf8")
};

function readAsset(
  name: keyof typeof assetSpecifiers,
  reader: VendorAssetReader
): string {
  const specifier = assetSpecifiers[name];
  const packageName = specifier.split("/")[0];
  const relativePath = specifier.slice(packageName.length + 1);
  let path: string;
  try {
    path = join(reader.resolvePackage(packageName), relativePath);
  } catch (error) {
    throw new Error(
      `Missing required Radius Canvas vendor asset "${specifier}". ` +
        "Install the pinned canvas dependencies before building.",
      { cause: error }
    );
  }

  try {
    if (!reader.exists(path)) {
      throw new Error("file does not exist");
    }
    return reader.read(path);
  } catch (error) {
    throw new Error(
      `Unable to read required Radius Canvas vendor asset "${specifier}" at "${path}".`,
      { cause: error }
    );
  }
}

export function readVendorAssets(
  reader: VendorAssetReader = defaultReader
): VendorAssets {
  return {
    react: readAsset("react", reader),
    reactDom: readAsset("reactDom", reader),
    reactFlow: readAsset("reactFlow", reader),
    dagre: readAsset("dagre", reader),
    reactFlowCss: readAsset("reactFlowCss", reader)
  };
}
