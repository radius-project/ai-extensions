// Bundles the AWS cleanup entry point into one file plain `node` can run.
// The sweep calls the product's deploy-role removal, whose TypeScript imports
// use `.js` specifiers that Node's type stripping can't resolve, so
// purge-aws runs this after `pnpm install` and then runs the bundle.
//
//   node aws-cloud-cleanup-bundle.ts <outfile>
//
// Node strips this file's types itself: it imports nothing relative.
import { build } from "esbuild";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export async function bundleAwsCleanup(outfile: string): Promise<void> {
  await build({
    entryPoints: [path.join(here, "aws-cloud-cleanup-main.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    logLevel: "warning",
    // Some dependencies `require` Node built-ins, which an ES module bundle
    // has no `require` for.
    banner: {
      js: 'import { createRequire as __cleanupRequire } from "node:module"; const require = __cleanupRequire(import.meta.url);'
    }
  });
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const outfile = process.argv[2];
  if (!outfile) {
    console.error("Usage: node aws-cloud-cleanup-bundle.ts <outfile>");
    process.exit(2);
  }
  await bundleAwsCleanup(path.resolve(outfile));
}
