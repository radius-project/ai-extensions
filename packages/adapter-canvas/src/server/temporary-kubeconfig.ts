import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TemporaryKubeconfig {
  readonly path: string;
  remove(): void;
}

interface TemporaryKubeconfigDependencies {
  mkdtemp(prefix: string): string;
  write(
    path: string,
    contents: string,
    options: { flag: "wx"; mode: number }
  ): void;
  remove(path: string): void;
}

const defaultDependencies: TemporaryKubeconfigDependencies = {
  mkdtemp: mkdtempSync,
  write: writeFileSync,
  remove: (path) => rmSync(path, { force: true, recursive: true })
};

export function createTemporaryKubeconfig(
  dependencies: TemporaryKubeconfigDependencies = defaultDependencies
): TemporaryKubeconfig {
  const directory = dependencies.mkdtemp(join(tmpdir(), "radius-kubeconfig-"));
  const path = join(directory, "config");
  try {
    dependencies.write(path, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    dependencies.remove(directory);
    throw error;
  }
  return {
    path,
    remove: () => dependencies.remove(directory)
  };
}
