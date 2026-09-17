import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runArtifactSmoke } from "./harness.js";

const requiredFiles = [
  "SKILL.md",
  "scripts/promote-app-model.mjs",
  "scripts/validate-bicep.mjs",
  "scripts/write-app-origin.mjs",
  "references/source-code-references.md"
];

// Synthetic transport markers test the harness, not lifecycle implementation.
const transportArtifact = `
import { createServer } from "node:http";
import { createCanvas, joinSession } from "@github/copilot-sdk/extension";
let server;
const canvas = createCanvas({
  id: "radius",
  inputSchema: {},
  actions: [],
  open: async () => {
    server = createServer((request, response) => response.end("transport page"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { url: "http://127.0.0.1:" + server.address().port };
  },
  onClose: async () => {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
});
const session = await joinSession({
  canvases: [canvas],
  hooks: {},
  tools: [
    {
      name: "radius_generate_app",
      parameters: {},
      handler: async () => JSON.stringify({ error: "transport refusal" })
    },
    {
      name: "radius_lifecycle",
      parameters: {},
      handler: async (intent) => JSON.stringify({
        marker: intent.operation,
        approved: intent.approved ?? false
      })
    }
  ]
});
process.on("SIGTERM", async () => {
  await session.close();
  process.exit(0);
});
`;

function smokeWorkspaces(): string[] {
  return readdirSync(process.cwd())
    .filter((entry) => entry.startsWith(".radius-artifact-smoke-"))
    .sort();
}

async function withArtifact(
  source: string,
  run: (artifact: string, root: string) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(process.cwd(), ".artifact-harness-fixture-"));
  const artifact = join(root, "extension.mjs");
  const before = smokeWorkspaces();
  try {
    writeFileSync(artifact, source);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ version: "1.2.3" })
    );
    writeFileSync(
      join(root, "plugin.json"),
      JSON.stringify({ version: "1.2.3" })
    );
    for (const file of requiredFiles) {
      const path = join(root, "skills", "radius-app-bicep", file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "packaged transport fixture\n");
    }
    await run(artifact, root);
    expect(smokeWorkspaces()).toEqual(before);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
}

describe("artifact smoke harness", () => {
  it("transports refusal and attached lifecycle evidence before opening the explicit page", async () => {
    await withArtifact(transportArtifact, async (artifact, root) => {
      const result = await runArtifactSmoke(artifact, 5_000, root);
      expect(result.registration.authoringBeforeAttachment).toEqual({
        result: { error: "transport refusal" },
        sessionSendCount: 0,
        panelOpenCount: 0,
        canvasOpenCount: 0,
        containsLegacyInlinedHeading: false
      });
      expect(result.registration.packagedSkill).toEqual({
        skillBaseRelativeToArtifact: "skills/radius-app-bicep",
        packageVersionPresent: true,
        pluginVersionMatchesPackage: true,
        requiredFiles
      });
      expect(result.lifecycle).toEqual({
        validationResult: {
          marker: "definition.validate",
          approved: false
        },
        invalidApprovalResult: {
          marker: "definition.validate",
          approved: true
        },
        authorResult: { marker: "definition.author", approved: false },
        sessionSendCount: 0,
        panelOpenCount: 0,
        canvasOpenCount: 0
      });
      expect(result.graphReadResult).toEqual({
        marker: "graph.get",
        approved: false
      });
      expect(result.renderedPage).toBe("transport page");
      expect(result.closeCount).toBe(1);
    });
  });

  it("reports missing packaged files and version mismatches without inventing bootstrap metadata", async () => {
    await withArtifact(transportArtifact, async (artifact, root) => {
      rmSync(join(root, "skills", "radius-app-bicep", "SKILL.md"));
      writeFileSync(join(root, "package.json"), JSON.stringify({}));
      const result = await runArtifactSmoke(artifact, 5_000, root);
      expect(result.registration.packagedSkill).toEqual({
        skillBaseRelativeToArtifact: "skills/radius-app-bicep",
        packageVersionPresent: false,
        pluginVersionMatchesPackage: false,
        requiredFiles: requiredFiles.slice(1)
      });
      expect(result.registration).not.toHaveProperty("bootstrap");
    });
  });

  it("detects unexpected session messages and panel requests before the explicit page", async () => {
    const source = transportArtifact.replace(
      'process.on("SIGTERM", async () => {',
      `
await session.send({ prompt: "unexpected handoff" });
await session.rpc.canvas.open({});
process.on("SIGTERM", async () => {
`
    );
    await withArtifact(source, async (artifact, root) => {
      const result = await runArtifactSmoke(artifact, 5_000, root);
      expect(result.lifecycle).toMatchObject({
        sessionSendCount: 1,
        panelOpenCount: 1,
        canvasOpenCount: 0
      });
    });
  });

  it("rejects missing attached lifecycle evidence and cleans up the child workspace", async () => {
    const source =
      `
const send = process.send.bind(process);
process.send = (message, callback) => {
  if (message.type === "lifecycle") {
    callback(null);
    return true;
  }
  return send(message, callback);
};
` + transportArtifact;
    await withArtifact(source, async (artifact, root) => {
      await expect(runArtifactSmoke(artifact, 5_000, root)).rejects.toThrow(
        "Artifact did not report attached lifecycle evidence."
      );
    });
  });

  it("reports page failure rather than returning partial lifecycle evidence", async () => {
    const source = transportArtifact.replace(
      'server = createServer((request, response) => response.end("transport page"));',
      'throw new Error("controlled page failure");'
    );
    await withArtifact(source, async (artifact, root) => {
      await expect(runArtifactSmoke(artifact, 5_000, root)).rejects.toThrow(
        /Artifact page render failed:.*controlled page failure/
      );
    });
  });

  it("preserves the subprocess guard and cleans up after blocked startup", async () => {
    const source = `
import childProcess from "node:child_process";
childProcess.spawnSync("must-not-run", []);
`;
    await withArtifact(source, async (artifact, root) => {
      await expect(runArtifactSmoke(artifact, 5_000, root)).rejects.toThrow(
        "Artifact attempted subprocess-spawn-sync: must-not-run"
      );
    });
  });
});
