// Opt-in smoke test for the real `rad app graph` path.
//
// Not wired into CI — run manually when a network connection is available (the
// first run downloads the `rad` binary and rad's embedded Bicep):
//
//   node adapters/canvas/scripts/smoke-rad.mjs
//
// It writes a tiny app.bicep, runs buildGraphViaRad, and asserts the converter
// returns at least one resource. Exits non-zero on failure.

import { buildGraphViaRad } from "../src/rad.mjs";

const SAMPLE_BICEP = `extension radius

param application string

resource frontend 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'frontend'
  properties: {
    application: application
    container: {
      image: 'ghcr.io/radius-project/samples/demo:latest'
    }
    connections: {
      cache: {
        source: cache.id
      }
    }
  }
}

resource cache 'Radius.Data/redisCaches@2025-08-01-preview' = {
  name: 'cache'
  properties: {
    application: application
  }
}
`;

async function main() {
  process.stderr.write("Running rad app graph on a sample app.bicep...\n");
  const resources = await buildGraphViaRad(SAMPLE_BICEP, ".radius/app.bicep", {
    log: (m) => process.stderr.write(`  ${m}\n`),
  });

  if (!Array.isArray(resources) || resources.length === 0) {
    throw new Error(`expected >=1 resource, got ${JSON.stringify(resources)}`);
  }

  for (const r of resources) {
    if (!r.id || !r.type) throw new Error(`resource missing id/type: ${JSON.stringify(r)}`);
  }

  process.stderr.write(`OK - ${resources.length} resource(s):\n`);
  for (const r of resources) {
    process.stderr.write(`  ${r.type}  ${r.name}  (${r.connections.length} connection(s))\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`SMOKE FAILED: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
