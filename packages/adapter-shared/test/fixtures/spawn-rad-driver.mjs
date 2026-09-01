import { spawnRad } from "../../src/rad-process.mjs";

const [, , radPath, childHarnessPath] = process.argv;
const result = await spawnRad(
  radPath,
  [childHarnessPath, "success", "contract"],
  { timeout: 5_000 }
);

process.stdout.write(JSON.stringify(result));
