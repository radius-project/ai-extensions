import { createHash } from "node:crypto";
import { appendFile, chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const assets = {
  linux: {
    name: "bicep-linux-x64",
    digest: "aed90eb2c69a6ee2bd70dc0d4354408ac4d04fd9911d3ec8e0cd74ad173e7139"
  },
  win32: {
    name: "bicep-win-x64.exe",
    digest: "dde63bab0d12da761cb75708d53d024a59c5f91a13a883d3e06c4ba951ee50f9"
  }
};
export async function installVerifiedCompiler(
  asset,
  directory,
  environmentFile,
  download = fetch
) {
  const response = await download(
    `https://github.com/Azure/bicep/releases/download/v0.42.1/${asset.name}`
  );
  if (!response.ok)
    throw new Error(
      `Pinned repair compiler download failed: HTTP ${response.status}`
    );
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== asset.digest)
    throw new Error("Pinned repair compiler checksum mismatch.");
  const file = path.join(directory, asset.name);
  await writeFile(file, bytes, { flag: "wx" });
  if (process.platform !== "win32") await chmod(file, 0o755);
  await appendFile(environmentFile, `RADIUS_REPAIR_TEST_BICEP=${file}\n`);
  return file;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const asset = assets[process.platform];
  if (
    !asset ||
    process.arch !== "x64" ||
    !process.env.RUNNER_TEMP ||
    !process.env.GITHUB_ENV
  )
    throw new Error(
      "Repair compiler setup requires an x64 Linux/Windows Actions runner."
    );
  await installVerifiedCompiler(
    asset,
    process.env.RUNNER_TEMP,
    process.env.GITHUB_ENV
  );
  console.log(`Installed test-only Bicep 0.42.1 (${asset.digest}).`);
}
