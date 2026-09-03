import path from "node:path";

const COPILOT_CLIENT_NAMESPACE = "com.github.copilot";
const COPILOT_EXTENSIONS_DIRECTORY = "extensions";

export function resolvePluginRoot(moduleDirectory: string): string {
  const extensionsDirectory = path.dirname(moduleDirectory);
  const namespaceDirectory = path.dirname(extensionsDirectory);
  if (
    path.basename(extensionsDirectory) === COPILOT_EXTENSIONS_DIRECTORY &&
    path.basename(namespaceDirectory) === COPILOT_CLIENT_NAMESPACE
  ) {
    return path.dirname(namespaceDirectory);
  }
  return moduleDirectory;
}
