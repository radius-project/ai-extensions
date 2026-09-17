import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile, link } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { renameSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  buildEffectiveInputManifest,
  portSuccess,
  portForbidden,
  portAbsent,
  createValidationPolicy,
  reduceValidationReport,
  type AuthorizedScope,
  type RequestControl,
  type SourceSelection,
  type SourceSnapshot,
  type StagedOutputs,
  type PromotionRequest
} from "@radius-project/core/lifecycle";
import {
  createSourceReadAdapter,
  nodeSourceFileSystem,
  type SourceReadDependencies
} from "./source-access.js";
import {
  createDefinitionPromotionAdapter,
  type DefinitionPromotionAdapter,
  type DefinitionPromotionMachinery
} from "./definition-promotion.js";
import { collectSourceInputs } from "./source-access-closure.js";

const scriptPath = fileURLToPath(
  new URL(
    "../../../../extensions/radius/skills/radius-app-bicep/scripts/promote-app-model.mjs",
    import.meta.url
  )
);
const native: DefinitionPromotionMachinery & {
  promoteStagedRun(
    options: Parameters<DefinitionPromotionMachinery["promoteStagedRun"]>[0],
    dependencies: { renameSync?: typeof renameSync; rmSync?: typeof rmSync }
  ): ReturnType<DefinitionPromotionMachinery["promoteStagedRun"]>;
} = await import(scriptPath);

let root: string;
let dependencies: SourceReadDependencies;
let reader: ReturnType<typeof createSourceReadAdapter>;
let adapter: DefinitionPromotionAdapter | undefined;
const control: RequestControl = {
  requestId: "request",
  cancellation: { aborted: false, onAbort: () => () => {} }
};
function absentFingerprint() {
  const result = buildEffectiveInputManifest(
    {
      definition: ".radius/app.bicep",
      closure: "complete",
      inputs: [
        {
          path: ".radius/app.bicep",
          kind: "definition",
          existed: false,
          contentHash: null
        },
        {
          path: ".radius/bicepconfig.json",
          kind: "configuration",
          existed: false,
          contentHash: null
        },
        {
          path: "bicepconfig.json",
          kind: "configuration",
          existed: false,
          contentHash: null
        }
      ]
    },
    (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`
  );
  if (result.status !== "ok" || result.value.completeness !== "complete")
    throw new Error("Invalid fixture");
  return result.value.fingerprint;
}
const selection = {
  repo: "example/shop",
  definition: ".radius/app.bicep",
  source: {
    kind: "workspace",
    workspaceRef: "workspace",
    branch: "feature/model",
    expectedFingerprint: absentFingerprint()
  }
} as const satisfies SourceSelection;
const scope: AuthorizedScope<"definition.author"> = {
  operation: "definition.author",
  target: selection,
  principalRef: "principal",
  authorizationRef: "authorization",
  approvalRef: "approval"
};
beforeEach(async () => {
  root = join(process.cwd(), ".artifacts", `authoring-${randomUUID()}`);
  await mkdir(join(root, "workspace"), { recursive: true });
  await mkdir(join(root, "storage"));
  dependencies = {
    storageRoot: join(root, "storage"),
    files: { ...nodeSourceFileSystem },
    limits: { maxFiles: 100, maxFileBytes: 10000, maxTotalBytes: 100000 },
    ids: { next: () => randomUUID() },
    clock: { now: () => "2026-09-16T00:00:00Z" },
    authority: {
      resolve: async () =>
        portSuccess({
          kind: "workspace",
          repo: selection.repo,
          workspaceRef: "workspace",
          rootPath: join(root, "workspace")
        })
    },
    git: {
      workspaceState: async () =>
        portSuccess({ branch: "feature/model", commit: "a".repeat(40) }),
      resolveCommit: async () => {
        throw new Error("No remote access");
      },
      materializeCommit: async () => {
        throw new Error("No remote access");
      },
      readCommit: async () => {
        throw new Error("No remote access");
      }
    }
  };
  reader = createSourceReadAdapter(dependencies);
  adapter = undefined;
});
afterEach(async () => {
  await reader.close();
  await adapter?.close();
  await rm(root, { recursive: true, force: true });
});

function digest(bytes: string | Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
async function prepared(
  machinery: DefinitionPromotionMachinery = native,
  originalFiles: Readonly<Record<string, string | Uint8Array>> = {}
) {
  for (const [path, bytes] of Object.entries(originalFiles)) {
    const file = join(root, "workspace", ...path.split("/"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  const original = await collectSourceInputs(
    dependencies.files,
    join(root, "workspace"),
    selection.definition,
    dependencies.limits,
    control.cancellation,
    "capture",
    true
  );
  const manifest = buildEffectiveInputManifest(
    {
      definition: selection.definition,
      inputs: original.inputs,
      closure: original.complete ? "complete" : "incomplete"
    },
    digest
  );
  if (manifest.status !== "ok" || manifest.value.completeness !== "complete")
    throw new Error("Incomplete fixture baseline");
  const target = {
    ...selection,
    source: {
      ...selection.source,
      expectedFingerprint: manifest.value.fingerprint
    }
  };
  const originalScope: AuthorizedScope<"definition.author"> = {
    ...scope,
    target
  };
  const initialized = spawnSync("git", ["init", "--quiet"], {
    cwd: join(root, "workspace")
  });
  expect(initialized.status).toBe(0);
  adapter = createDefinitionPromotionAdapter({
    source: dependencies,
    staging: machinery
  });
  const captured = await adapter.captureForAuthoring(
    originalScope,
    target,
    control
  );
  if (captured.status !== "ok" || captured.value.status !== "captured")
    throw new Error(`Expected captured source: ${JSON.stringify(captured)}`);
  const snapshot = captured.value.snapshot;
  const operationScope: AuthorizedScope<"definition.author"> = {
    ...originalScope,
    operationId: "operation",
    source: snapshot.provenance
  };
  const staged = await adapter.prepareStaging(
    operationScope,
    {
      operationId: "operation",
      actionId: "action",
      snapshot
    },
    control
  );
  if (staged.status !== "ok")
    throw new Error(`Expected staging: ${JSON.stringify(staged)}`);
  const area = staged.value;
  const location = await adapter.stagingLocation(area, control);
  if (location.status !== "ok")
    throw new Error("Expected trusted staging location");
  const files = {
    "app.bicep": "param name string\n",
    "bicepconfig.json": "{}",
    "app.origin.json": JSON.stringify({
      appBicepHash: digest("param name string")
    })
  };
  for (const [name, text] of Object.entries(files))
    await writeFile(join(location.value, name), text);
  const refs = Object.keys(files).map((name) => `${area.stagingRef}/${name}`);
  const outputs = await adapter.inspectStagedOutputs(area, refs, control);
  if (outputs.status !== "ok")
    throw new Error(`Expected outputs: ${JSON.stringify(outputs)}`);
  const proposal = await adapter.captureProposal(outputs.value, control);
  if (proposal.status !== "ok" || proposal.value.status !== "captured")
    throw new Error(`Expected captured proposal: ${JSON.stringify(proposal)}`);
  return {
    adapter,
    snapshot,
    area,
    location: location.value,
    outputs: outputs.value,
    proposal: proposal.value.snapshot,
    operationScope,
    request: promotionRequest(
      operationScope,
      snapshot,
      outputs.value,
      proposal.value.snapshot
    )
  };
}
function promotionRequest(
  operationScope: AuthorizedScope<"definition.author">,
  snapshot: SourceSnapshot,
  outputs: StagedOutputs,
  proposal: SourceSnapshot
): PromotionRequest {
  const policy = createValidationPolicy("authoring");
  return {
    scope: operationScope,
    outputs,
    expectedManifest: snapshot.manifest,
    proposal: {
      operationId: outputs.staging.operationId,
      actionId: outputs.staging.actionId,
      stagingRef: outputs.staging.stagingRef,
      outputs: outputs.outputs.map((input) => ({ ...input })),
      originalFingerprint: snapshot.manifest.fingerprint,
      promotion: "pending",
      validation: reduceValidationReport(
        policy,
        policy.checks.map((check) => ({
          ...check,
          status: "passed",
          reason: "Fixture validation performed."
        })),
        {
          sourceFingerprint: snapshot.manifest.fingerprint,
          proposalFingerprint: proposal.manifest.fingerprint
        }
      )
    }
  };
}
it("publishes owned validated bytes through the real writer without staging git or changing unrelated edits", async () => {
  const fixture = await prepared();
  const note = join(root, "workspace", "notes.txt");
  await writeFile(note, "user edit");
  expect(await fixture.adapter.promote(fixture.request, control)).toEqual({
    status: "promoted",
    manifest: fixture.proposal.manifest
  });
  expect(
    await readFile(join(root, "workspace", ".radius", "app.bicep"), "utf8")
  ).toBe("param name string\n");
  expect(await readFile(note, "utf8")).toBe("user edit");
  expect(
    spawnSync("git", ["diff", "--cached", "--name-only"], {
      cwd: join(root, "workspace"),
      encoding: "utf8"
    }).stdout
  ).toBe("");
  expect(await fixture.adapter.promote(fixture.request, control)).toMatchObject(
    { status: "refused" }
  );
  expect(await fixture.adapter.releaseStaging(fixture.area)).toMatchObject({
    status: "ok"
  });
  expect(await fixture.adapter.releaseStaging(fixture.area)).toMatchObject({
    status: "ok",
    value: { status: "already_released" }
  });
});
it.each(["app.bicep", "bicepconfig.json", "app.origin.json"])(
  "rejects altered %s after proposal validation",
  async (name) => {
    const fixture = await prepared();
    await writeFile(join(fixture.location, name), "changed validated bytes");
    expect(
      await fixture.adapter.promote(fixture.request, control)
    ).toMatchObject({ status: "refused" });
    await expect(
      readFile(join(root, "workspace", ".radius", "app.bicep"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  }
);
it.each([
  ".radius/app.bicep",
  ".radius/bicepconfig.json",
  "bicepconfig.json",
  ".radius/app.origin.json"
])("preserves newly added baseline destination %s", async (path) => {
  const fixture = await prepared();
  const destination = join(root, "workspace", ...path.split("/"));
  await writeFile(destination, "user edit");
  expect(await fixture.adapter.promote(fixture.request, control)).toMatchObject(
    { status: "refused" }
  );
  expect(await readFile(destination, "utf8")).toBe("user edit");
});
it.each([
  "../app.bicep",
  "C:/app.bicep",
  "\\\\host\\app.bicep",
  "app.bicep/../app.bicep",
  "notes.txt",
  "APP.bicep"
])("rejects unsafe or unowned staged output %s", async (name) => {
  const fixture = await prepared();
  expect(
    await fixture.adapter.inspectStagedOutputs(
      fixture.area,
      [`${fixture.area.stagingRef}/${name}`],
      control
    )
  ).toMatchObject({ status: "forbidden" });
});
it("rejects foreign objects, malformed output sets, and spoofed report authority", async () => {
  const fixture = await prepared();
  expect(
    await fixture.adapter.stagingLocation(
      structuredClone(fixture.area),
      control
    )
  ).toMatchObject({ status: "failed" });
  expect(
    await fixture.adapter.captureProposal(
      structuredClone(fixture.outputs),
      control
    )
  ).toMatchObject({ status: "failed" });
  expect(
    await fixture.adapter.inspectStagedOutputs(fixture.area, [], control)
  ).toMatchObject({ status: "failed" });
  expect(
    await fixture.adapter.inspectStagedOutputs(
      fixture.area,
      [fixture.outputs.outputRefs[0], fixture.outputs.outputRefs[0]],
      control
    )
  ).toMatchObject({ status: "failed" });
  expect(
    await fixture.adapter.inspectStagedOutputs(
      fixture.area,
      ["foreign/app.bicep"],
      control
    )
  ).toMatchObject({ status: "forbidden" });
  expect(
    await fixture.adapter.inspectStagedOutputs(
      fixture.area,
      [fixture.outputs.outputRefs[0]],
      control
    )
  ).toMatchObject({ status: "failed" });
  expect(
    await fixture.adapter.promote(
      {
        ...fixture.request,
        scope: { ...fixture.request.scope, principalRef: "intruder" }
      },
      control
    )
  ).toMatchObject({ status: "refused", failure: { status: "forbidden" } });
  expect(
    await fixture.adapter.promote(
      {
        ...fixture.request,
        proposal: { ...fixture.request.proposal, actionId: "other" }
      },
      control
    )
  ).toMatchObject({ status: "refused", failure: { status: "failed" } });
});
it("rechecks authority before each replacement and rolls back when approval is withdrawn", async () => {
  let guards = 0;
  const fixture = await prepared({
    ...native,
    promoteStagedRun: (options) =>
      native.promoteStagedRun({
        ...options,
        checkInputs: async (published) => {
          guards++;
          if (published?.length)
            dependencies.authority.resolve = async () => portForbidden();
          await options.checkInputs(published);
        }
      })
  });
  expect(await fixture.adapter.promote(fixture.request, control)).toMatchObject(
    {
      status: "failed",
      rollback: "restored"
    }
  );
  expect(guards).toBe(3);
  await expect(
    readFile(join(root, "workspace", ".radius", "app.bicep"))
  ).rejects.toMatchObject({ code: "ENOENT" });
});
it("rolls back partial writes and retains explicit failed-rollback recovery", async () => {
  let moves = 0;
  const fixture = await prepared({
    ...native,
    promoteStagedRun: (options) =>
      native.promoteStagedRun(options, {
        renameSync: (from, to) => {
          if (++moves === 2) throw new Error("Controlled replacement failure");
          renameSync(from, to);
        },
        rmSync: (path, options) => {
          if (String(path).endsWith("app.bicep"))
            throw new Error("Controlled rollback failure");
          rmSync(path, options);
        }
      })
  });
  expect(await fixture.adapter.promote(fixture.request, control)).toMatchObject(
    { status: "failed", rollback: "incomplete" }
  );
  expect(await fixture.adapter.releaseStaging(fixture.area)).toMatchObject({
    status: "failed"
  });
});
it("honors cancellation, cleanup retries, and shutdown without admitting new work", async () => {
  let fail = true;
  const fixture = await prepared({
    ...native,
    abortStagedRun: (options) => {
      if (fail) throw new Error("Controlled cleanup failure");
      return native.abortStagedRun(options);
    }
  });
  const cancelled: RequestControl = {
    ...control,
    cancellation: { aborted: true, onAbort: () => () => {} }
  };
  expect(
    await fixture.adapter.promote(fixture.request, cancelled)
  ).toMatchObject({ status: "cancelled" });
  expect(await fixture.adapter.releaseStaging(fixture.area)).toMatchObject({
    status: "failed"
  });
  fail = false;
  expect(await fixture.adapter.releaseStaging(fixture.area)).toMatchObject({
    status: "ok"
  });
  expect(await fixture.adapter.close()).toMatchObject({ status: "ok" });
  expect(
    await fixture.adapter.stagingLocation(fixture.area, control)
  ).toMatchObject({ status: "cancelled" });
});
it("fails construction without real promotion dependencies", () => {
  expect(() =>
    Reflect.apply(createDefinitionPromotionAdapter, undefined, [
      { source: dependencies }
    ])
  ).toThrow("staging machinery");
});
it.each([
  ["module", ".radius/part.bicep", "changed"],
  ["module", ".radius/part.bicep", "deleted"],
  ["binary", ".radius/data.bin", "changed"],
  ["binary", ".radius/data.bin", "deleted"],
  ["configuration", ".radius/bicepconfig.json", "changed"],
  ["configuration", ".radius/bicepconfig.json", "deleted"],
  ["configuration", "bicepconfig.json", "added"]
])("fences %s effective input %s when %s", async (_kind, path, change) => {
  const fixture = await prepared(native, {
    ".radius/app.bicep":
      "module part './part.bicep' = {}\nvar data = loadFileAsBase64('./data.bin')",
    ".radius/part.bicep": "param name string",
    ".radius/data.bin": new Uint8Array([255, 0, 1]),
    ".radius/bicepconfig.json": "{}"
  });
  const original = await fixture.adapter.readBytes(
    fixture.snapshot,
    ".radius/data.bin",
    control
  );
  expect(original).toMatchObject({
    status: "ok",
    value: { bytes: new Uint8Array([255, 0, 1]) }
  });
  const target = join(root, "workspace", ...path.split("/"));
  if (change === "deleted") await rm(target);
  else
    await writeFile(
      target,
      path.endsWith(".json") ? '{"extensions":{}}' : "changed"
    );
  const result = await fixture.adapter.promote(fixture.request, control);
  expect(result.status).toBe("refused");
});
it("rejects nearest configuration appearing for an original nested module", async () => {
  const fixture = await prepared(native, {
    ".radius/app.bicep": "module part './modules/part.bicep' = {}",
    ".radius/modules/part.bicep": "param name string",
    ".radius/bicepconfig.json": "{}"
  });
  await writeFile(
    join(root, "workspace", ".radius", "modules", "bicepconfig.json"),
    "{}"
  );
  expect(await fixture.adapter.promote(fixture.request, control)).toMatchObject(
    { status: "refused" }
  );
});
it("captures retained dependencies into the proposal while rejecting a retrospective dependency baseline", async () => {
  const fixture = await prepared(native, {
    ".radius/app.bicep": "var data = loadTextContent('./data.txt')",
    ".radius/data.txt": "original bytes"
  });
  await writeFile(
    join(fixture.location, "app.bicep"),
    "var data = loadTextContent('./data.txt')"
  );
  const inspected = await fixture.adapter.inspectStagedOutputs(
    fixture.area,
    fixture.outputs.outputRefs,
    control
  );
  if (inspected.status !== "ok") throw new Error("Expected inspected output");
  const captured = await fixture.adapter.captureProposal(
    inspected.value,
    control
  );
  if (captured.status !== "ok" || captured.value.status !== "captured")
    throw new Error("Expected complete merged closure");
  expect(
    await fixture.adapter.readText(
      captured.value.snapshot,
      ".radius/data.txt",
      control
    )
  ).toMatchObject({ status: "ok", value: { text: "original bytes" } });
  await writeFile(
    join(fixture.location, "app.bicep"),
    "var data = loadTextContent('./new.txt')"
  );
  await writeFile(join(root, "workspace", ".radius", "new.txt"), "too late");
  const next = await fixture.adapter.inspectStagedOutputs(
    fixture.area,
    fixture.outputs.outputRefs,
    control
  );
  if (next.status !== "ok") throw new Error("Expected output");
  expect(
    await fixture.adapter.captureProposal(next.value, control)
  ).toMatchObject({ status: "ok", value: { status: "incomplete" } });
  expect(
    await fixture.adapter.captureProposal(inspected.value, control)
  ).toMatchObject({ status: "forbidden" });
});
it("owns binary custom artifacts and recipe outputs without exposing their physical paths", async () => {
  const fixture = await prepared();
  const extras = {
    "custom-types.yaml": Buffer.from("name: synthetic"),
    "custom-types.tgz": Buffer.from([255, 0, 1]),
    "custom-recipe-pack.bicep": Buffer.from("param name string"),
    "cache-recipe.bicep": Buffer.from("param name string")
  };
  for (const [name, bytes] of Object.entries(extras))
    await writeFile(join(fixture.location, name), bytes);
  const inspected = await fixture.adapter.inspectStagedOutputs(
    fixture.area,
    [
      ...fixture.outputs.outputRefs,
      ...Object.keys(extras).map((name) => `${fixture.area.stagingRef}/${name}`)
    ],
    control
  );
  if (inspected.status !== "ok") throw new Error("Expected custom artifacts");
  const proposed = await fixture.adapter.captureProposal(
    inspected.value,
    control
  );
  if (proposed.status !== "ok" || proposed.value.status !== "captured")
    throw new Error("Expected proposed artifact bytes");
  expect(JSON.stringify(proposed.value)).not.toContain(root);
  const read = await fixture.adapter.readBytes(
    proposed.value.snapshot,
    ".radius/custom-types.tgz",
    control
  );
  expect(read).toMatchObject({
    status: "ok",
    value: { bytes: new Uint8Array([255, 0, 1]) }
  });
  expect(
    await fixture.adapter.readText(
      proposed.value.snapshot,
      ".radius/custom-types.tgz",
      control
    )
  ).toMatchObject({ status: "unavailable" });
  expect(
    await fixture.adapter.releaseSnapshot(proposed.value.snapshot)
  ).toMatchObject({ status: "ok" });
  expect(
    await fixture.adapter.releaseSnapshot(proposed.value.snapshot)
  ).toMatchObject({ status: "ok", value: { status: "already_released" } });
  expect(
    await fixture.adapter.releaseSnapshot(structuredClone(fixture.snapshot))
  ).toMatchObject({ status: "unavailable" });
});
it("rejects hardlinked proposed outputs and missing staged files", async () => {
  const fixture = await prepared();
  const destination = join(fixture.location, "app.bicep");
  await link(destination, join(root, "alias.bicep"));
  expect(
    await fixture.adapter.inspectStagedOutputs(
      fixture.area,
      fixture.outputs.outputRefs,
      control
    )
  ).toMatchObject({ status: "forbidden" });
  await rm(join(root, "alias.bicep"));
  await rm(destination);
  expect(
    await fixture.adapter.inspectStagedOutputs(
      fixture.area,
      fixture.outputs.outputRefs,
      control
    )
  ).toMatchObject({ status: "failed" });
});
it("rejects incomplete and tampered validation reports before entering the writer", async () => {
  const fixture = await prepared();
  const report = fixture.request.proposal.validation;
  const validation = reduceValidationReport(
    createValidationPolicy("authoring"),
    report.checks.map((check) => ({ ...check, status: "unavailable" })),
    {
      sourceFingerprint: report.sourceFingerprint,
      proposalFingerprint: report.proposalFingerprint
    }
  );
  expect(
    await fixture.adapter.promote(
      {
        ...fixture.request,
        proposal: { ...fixture.request.proposal, validation }
      },
      control
    )
  ).toMatchObject({
    status: "refused",
    failure: { error: { code: "VALIDATION_FAILED" } }
  });
  expect(
    await fixture.adapter.promote(
      {
        ...fixture.request,
        proposal: {
          ...fixture.request.proposal,
          validation: { ...validation, status: "passed" }
        }
      },
      control
    )
  ).toMatchObject({
    status: "refused",
    failure: { error: { code: "EVIDENCE_MISMATCH" } }
  });
});
it.each(["branch", "commit", "authority-root", "authority-absent"])(
  "rejects changed %s without accepting the report as authority",
  async (change) => {
    const fixture = await prepared();
    if (change === "branch")
      dependencies.git.workspaceState = async () =>
        portSuccess({ branch: "other", commit: "a".repeat(40) });
    if (change === "commit")
      dependencies.git.workspaceState = async () =>
        portSuccess({ branch: "feature/model", commit: "b".repeat(40) });
    if (change === "authority-root")
      dependencies.authority.resolve = async () =>
        portSuccess({
          kind: "workspace",
          rootPath: root,
          repo: selection.repo,
          workspaceRef: "workspace"
        });
    if (change === "authority-absent")
      dependencies.authority.resolve = async () =>
        portAbsent({
          quality: "current",
          completeness: "complete",
          evidence: "source",
          observedAt: "2026-09-16T00:00:00Z"
        });
    expect(
      await fixture.adapter.promote(fixture.request, control)
    ).toMatchObject({ status: "refused" });
  }
);
it("rejects forged staging bindings and invalid operation handles before calling native staging", async () => {
  const fixture = await prepared();
  const binding = {
    operationId: "operation",
    actionId: "action",
    snapshot: fixture.snapshot
  };
  expect(
    await fixture.adapter.prepareStaging(
      fixture.operationScope,
      { ...binding, snapshot: structuredClone(fixture.snapshot) },
      control
    )
  ).toMatchObject({ status: "forbidden" });
  expect(
    await fixture.adapter.prepareStaging(
      fixture.operationScope,
      { ...binding, actionId: "../escape" },
      control
    )
  ).toMatchObject({ status: "forbidden" });
  dependencies.ids.next = () => "../escape";
  expect(
    await fixture.adapter.prepareStaging(
      fixture.operationScope,
      binding,
      control
    )
  ).toMatchObject({ status: "failed" });
});
function deferred() {
  let resolve: () => void = () => {
    throw new Error("Uninitialized deferred");
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("serializes competing promotion and waits for active writes before idempotent cleanup", async () => {
  const entered = deferred();
  const proceed = deferred();
  const fixture = await prepared({
    ...native,
    promoteStagedRun: async (options) => {
      entered.resolve();
      await proceed.promise;
      return native.promoteStagedRun(options);
    }
  });
  const first = fixture.adapter.promote(fixture.request, control);
  await entered.promise;
  expect(await fixture.adapter.promote(fixture.request, control)).toMatchObject(
    { status: "refused" }
  );
  const release1 = fixture.adapter.releaseStaging(fixture.area);
  const release2 = fixture.adapter.releaseStaging(fixture.area);
  proceed.resolve();
  expect(await first).toMatchObject({ status: "promoted" });
  expect(await release1).toMatchObject({ status: "ok" });
  expect(await release2).toMatchObject({ status: "ok" });
  expect(
    await fixture.adapter.releaseStaging(structuredClone(fixture.area))
  ).toMatchObject({ status: "unavailable" });
});
it("cancels in-flight native publication on shutdown and joins cleanup", async () => {
  const entered = deferred();
  const proceed = deferred();
  const fixture = await prepared({
    ...native,
    promoteStagedRun: async (options) => {
      entered.resolve();
      await proceed.promise;
      return native.promoteStagedRun(options);
    }
  });
  const work = fixture.adapter.promote(fixture.request, control);
  await entered.promise;
  const closing = fixture.adapter.close();
  proceed.resolve();
  expect(await work).toMatchObject({ status: "cancelled" });
  expect(await closing).toMatchObject({ status: "ok" });
});
it("does not misreport native finalization errors as successful promotion", async () => {
  const fixture = await prepared({
    ...native,
    promoteStagedRun: (options) =>
      native.promoteStagedRun(options, {
        rmSync: () => {
          throw new Error("Controlled finalization failure");
        }
      })
  });
  expect(await fixture.adapter.promote(fixture.request, control)).toMatchObject(
    { status: "failed", rollback: "not_needed" }
  );
});
async function readerSnapshot() {
  const captured = await reader.captureForAuthoring(scope, selection, control);
  if (captured.status !== "ok" || captured.value.status !== "captured")
    throw new Error("Expected owned source");
  return captured.value.snapshot;
}
it("rejects unsupported authoring definitions and remote first-model capture without weakening reads", async () => {
  adapter = createDefinitionPromotionAdapter({
    source: dependencies,
    staging: native
  });
  const other = { ...selection, definition: "app.bicep" };
  expect(
    await adapter.captureForAuthoring(
      { ...scope, target: other },
      other,
      control
    )
  ).toMatchObject({ status: "unavailable" });
  expect(
    await adapter.captureForAuthoring(scope, other, control)
  ).toMatchObject({ status: "forbidden" });
  dependencies.authority.resolve = async () =>
    portSuccess({ kind: "git", repo: selection.repo, accessRef: "remote" });
  expect(
    await reader.captureForAuthoring(
      scope,
      {
        ...selection,
        source: {
          kind: "git",
          ref: "feature/model",
          expectedCommit: "a".repeat(40)
        }
      },
      control
    )
  ).toMatchObject({ status: "forbidden" });
});
it("checks authoring snapshot ownership, branch context, and revoked authority", async () => {
  const snapshot = await readerSnapshot();
  expect(
    await reader.authoringLocation(structuredClone(snapshot), control)
  ).toMatchObject({ status: "unavailable" });
  dependencies.authority.resolve = async () =>
    portSuccess({
      kind: "workspace",
      repo: selection.repo,
      workspaceRef: "workspace",
      rootPath: root
    });
  expect(await reader.authoringLocation(snapshot, control)).toMatchObject({
    status: "forbidden"
  });
  dependencies.authority.resolve = async () =>
    portSuccess({
      kind: "workspace",
      repo: selection.repo,
      workspaceRef: "workspace",
      rootPath: join(root, "workspace")
    });
  dependencies.git.workspaceState = async () =>
    portSuccess({ branch: "other", commit: "a".repeat(40) });
  expect(await reader.authoringLocation(snapshot, control)).toMatchObject({
    status: "failed"
  });
});
it.each([
  "empty",
  "too-many",
  "too-large",
  "total-too-large",
  "traversal",
  "alias"
])("rejects %s proposed snapshot input safely", async (kind) => {
  const snapshot = await readerSnapshot();
  const bytes = new Map<string, Uint8Array>([
    [".radius/app.bicep", Buffer.from("param name string")]
  ]);
  if (kind === "empty") bytes.clear();
  if (kind === "too-many")
    for (let i = 0; i < 100; i++) bytes.set(`file${i}`, Buffer.from("x"));
  if (kind === "too-large") bytes.set("large", Buffer.alloc(10001));
  if (kind === "total-too-large")
    for (let i = 0; i < 11; i++) bytes.set(`file${i}`, Buffer.alloc(10000));
  if (kind === "traversal") bytes.set("../escape", Buffer.from("x"));
  if (kind === "alias") bytes.set(".radius/APP.bicep", Buffer.from("x"));
  const result = await reader.captureOverlay(snapshot, bytes, control);
  expect(result.status).not.toBe("ok");
  expect(await reader.authoringLocation(snapshot, control)).toMatchObject({
    status: "ok"
  });
});
it.each(["success-shaped-incomplete", "primary-error"])(
  "surfaces overlay cleanup failure with %s precedence",
  async (mode) => {
    const snapshot = await readerSnapshot();
    const originalRemove = dependencies.files.remove;
    const bytes = new Map([
      [
        ".radius/app.bicep",
        Buffer.from(
          mode === "primary-error" ?
            "var value = loadTextContent('C:/escape')"
          : "var value = loadTextContent('./missing')"
        )
      ]
    ]);
    dependencies.files.remove = async () => {
      throw new Error("Controlled cleanup failure");
    };
    const result = await reader.captureOverlay(snapshot, bytes, control);
    expect(result).toMatchObject({
      status: "failed",
      error: {
        details: expect.arrayContaining([
          expect.objectContaining({
            message: "Source cleanup did not complete."
          })
        ])
      }
    });
    dependencies.files.remove = originalRemove;
  }
);
it("treats recipe dependencies as part of the proposed closure even when the app does not reference the recipe", async () => {
  const fixture = await prepared();
  await writeFile(
    join(fixture.location, "cache-recipe.bicep"),
    "var input = loadTextContent('./new.txt')"
  );
  const result = await fixture.adapter.inspectStagedOutputs(
    fixture.area,
    [
      ...fixture.outputs.outputRefs,
      `${fixture.area.stagingRef}/cache-recipe.bicep`
    ],
    control
  );
  if (result.status !== "ok") throw new Error("Expected recipe output");
  expect(
    await fixture.adapter.captureProposal(result.value, control)
  ).toMatchObject({ status: "ok", value: { status: "incomplete" } });
});
it.each(["clean", "cleanup-failed", "cancelled-cleanup-failed"])(
  "surfaces baseline capture failure with %s cleanup",
  async (mode) => {
    const remove = dependencies.files.remove;
    const readdir = dependencies.files.readdir;
    let aborted = false;
    const request: RequestControl = {
      ...control,
      cancellation: {
        get aborted() {
          return aborted;
        },
        onAbort: () => () => {}
      }
    };
    dependencies.files.readdir = async (path) => {
      if (path === join(root, "workspace", ".radius")) {
        if (mode === "cancelled-cleanup-failed") {
          aborted = true;
          return [];
        }
        throw Object.assign(new Error("Controlled directory read failure"), {
          code: "EACCES"
        });
      }
      return readdir(path);
    };
    if (mode !== "clean")
      dependencies.files.remove = async () => {
        throw new Error("Controlled cleanup failure");
      };
    adapter = createDefinitionPromotionAdapter({
      source: dependencies,
      staging: native
    });
    const result = await adapter.captureForAuthoring(scope, selection, request);
    expect(result.status).toBe(
      mode === "cancelled-cleanup-failed" ? "failed" : "unavailable"
    );
    if (mode !== "clean")
      expect(result).toMatchObject({
        error: {
          details: expect.arrayContaining([
            expect.objectContaining({
              message: "Source cleanup did not complete."
            })
          ])
        }
      });
    dependencies.files.remove = remove;
    dependencies.files.readdir = readdir;
  }
);
it("returns incomplete baseline capture and cancellation instead of staging unsupported sources", async () => {
  await mkdir(join(root, "workspace", ".radius"));
  await writeFile(
    join(root, "workspace", ".radius", "app.bicep"),
    "var name = 'data'\nvar data = loadTextContent(name)"
  );
  adapter = createDefinitionPromotionAdapter({
    source: dependencies,
    staging: native
  });
  expect(
    await adapter.captureForAuthoring(scope, selection, control)
  ).toMatchObject({
    status: "ok",
    value: { status: "incomplete" }
  });
  await adapter.close();
  expect(
    await adapter.captureForAuthoring(scope, selection, control)
  ).toMatchObject({ status: "cancelled" });
});
it("prevents authorization changes from disclosing trusted staging paths", async () => {
  const fixture = await prepared();
  dependencies.authority.resolve = async () =>
    portSuccess({
      kind: "workspace",
      repo: selection.repo,
      workspaceRef: "workspace",
      rootPath: root
    });
  expect(
    await fixture.adapter.stagingLocation(fixture.area, control)
  ).toMatchObject({ status: "forbidden" });
});
it("serializes contenders before native promotion begins", async () => {
  const fixture = await prepared();
  const resolve = dependencies.authority.resolve;
  const entered = deferred();
  const proceed = deferred();
  let waiting = true;
  dependencies.authority.resolve = async (...args) => {
    if (waiting) {
      waiting = false;
      entered.resolve();
      await proceed.promise;
    }
    return resolve(...args);
  };
  const first = fixture.adapter.promote(fixture.request, control);
  await entered.promise;
  expect(await fixture.adapter.promote(fixture.request, control)).toMatchObject(
    {
      status: "refused",
      failure: { error: { code: "PRECONDITION_FAILED" } }
    }
  );
  proceed.resolve();
  expect(await first).toMatchObject({ status: "promoted" });
  await fixture.adapter.close();
  expect(await fixture.adapter.promote(fixture.request, control)).toMatchObject(
    { status: "cancelled" }
  );
});
it("cancels before native promotion when shutdown arrives during source reads", async () => {
  const fixture = await prepared();
  const resolve = dependencies.authority.resolve;
  const entered = deferred();
  const proceed = deferred();
  let waiting = true;
  dependencies.authority.resolve = async (...args) => {
    if (waiting) {
      waiting = false;
      entered.resolve();
      await proceed.promise;
    }
    return resolve(...args);
  };
  const first = fixture.adapter.promote(fixture.request, control);
  await entered.promise;
  const closing = fixture.adapter.close();
  proceed.resolve();
  expect(await first).toMatchObject({ status: "cancelled" });
  expect(await closing).toMatchObject({ status: "ok" });
});
it("joins a releasing original snapshot without exposing an orphaned proposal", async () => {
  const snapshot = await readerSnapshot();
  const resolve = dependencies.authority.resolve;
  const entered = deferred();
  const proceed = deferred();
  dependencies.authority.resolve = async (...args) => {
    entered.resolve();
    await proceed.promise;
    return resolve(...args);
  };
  const work = reader.captureOverlay(
    snapshot,
    new Map([[".radius/app.bicep", Buffer.from("param name string")]]),
    control
  );
  await entered.promise;
  const releasing = reader.releaseSnapshot(snapshot);
  proceed.resolve();
  expect(await work).toMatchObject({ status: "unavailable" });
  expect(await releasing).toMatchObject({ status: "ok" });
});
it.each(["clean", "cleanup-failed"])(
  "rejects conflicting output roles with %s cleanup",
  async (mode) => {
    const fixture = await prepared();
    await writeFile(
      join(fixture.location, "app.bicep"),
      "module recipe './cache-recipe.bicep' = {}"
    );
    await writeFile(
      join(fixture.location, "cache-recipe.bicep"),
      "param name string"
    );
    const result = await fixture.adapter.inspectStagedOutputs(
      fixture.area,
      [
        ...fixture.outputs.outputRefs,
        `${fixture.area.stagingRef}/cache-recipe.bicep`
      ],
      control
    );
    if (result.status !== "ok") throw new Error("Expected staged recipe");
    const remove = dependencies.files.remove;
    if (mode === "cleanup-failed")
      dependencies.files.remove = async () => {
        throw new Error("Controlled snapshot cleanup failure");
      };
    expect(
      await fixture.adapter.captureProposal(result.value, control)
    ).toMatchObject({
      status: "failed",
      error: { code: "EVIDENCE_MISMATCH" }
    });
    dependencies.files.remove = remove;
  }
);
it("rejects outputs exceeding the aggregate capture budget", async () => {
  const fixture = await prepared();
  const refs = [...fixture.outputs.outputRefs];
  for (let i = 0; i < 20; i++) {
    const name = `extra${i}-recipe.bicep`;
    await writeFile(join(fixture.location, name), " ".repeat(6000));
    refs.push(`${fixture.area.stagingRef}/${name}`);
  }
  expect(
    await fixture.adapter.inspectStagedOutputs(fixture.area, refs, control)
  ).toMatchObject({
    status: "unavailable",
    error: { code: "VALIDATION_INCOMPLETE" }
  });
});
it("preserves native pre-existing recovery files", async () => {
  const fixture = await prepared();
  const backup = join(fixture.location, "app.bicep.published-backup");
  await writeFile(backup, "recovery");
  expect(await fixture.adapter.promote(fixture.request, control)).toMatchObject(
    { status: "refused" }
  );
  expect(await fixture.adapter.releaseStaging(fixture.area)).toMatchObject({
    status: "failed"
  });
  expect(await readFile(backup, "utf8")).toBe("recovery");
});
it("does not release staging when an in-flight write subsequently needs recovery", async () => {
  const entered = deferred();
  const proceed = deferred();
  let moves = 0;
  const fixture = await prepared({
    ...native,
    promoteStagedRun: async (options) => {
      entered.resolve();
      await proceed.promise;
      return native.promoteStagedRun(options, {
        renameSync: (from, to) => {
          if (++moves === 2) throw new Error("Controlled replacement failure");
          renameSync(from, to);
        },
        rmSync: () => {
          throw new Error("Controlled restoration failure");
        }
      });
    }
  });
  const promotion = fixture.adapter.promote(fixture.request, control);
  await entered.promise;
  const releasing = fixture.adapter.releaseStaging(fixture.area);
  proceed.resolve();
  expect(await promotion).toMatchObject({
    status: "failed",
    rollback: "incomplete"
  });
  expect(await releasing).toMatchObject({ status: "failed" });
});
it.each(["source-failure", "cancellation"])(
  "retains %s precedence when native cleanup fails",
  async (mode) => {
    const controller = new AbortController();
    const requestControl: RequestControl = {
      ...control,
      cancellation: {
        get aborted() {
          return controller.signal.aborted;
        },
        onAbort(listener) {
          controller.signal.addEventListener("abort", listener);
          return () => controller.signal.removeEventListener("abort", listener);
        }
      }
    };
    const fixture = await prepared({
      ...native,
      promoteStagedRun: (options) => {
        if (mode === "cancellation") controller.abort();
        else dependencies.authority.resolve = async () => portForbidden();
        return native.promoteStagedRun(options, {
          rmSync: () => {
            throw new Error("Controlled cleanup failure");
          }
        });
      }
    });
    const result = await fixture.adapter.promote(
      fixture.request,
      requestControl
    );
    expect(result).toMatchObject({
      status: "refused",
      failure: {
        status: mode === "cancellation" ? "failed" : "forbidden",
        error: {
          details: expect.arrayContaining([
            expect.objectContaining({
              message: "Source cleanup did not complete."
            })
          ])
        }
      }
    });
  }
);
it("does not turn failed cancellation rollback into success-shaped cancellation", async () => {
  const controller = new AbortController();
  const requestControl: RequestControl = {
    ...control,
    cancellation: {
      get aborted() {
        return controller.signal.aborted;
      },
      onAbort(listener) {
        controller.signal.addEventListener("abort", listener);
        return () => controller.signal.removeEventListener("abort", listener);
      }
    }
  };
  const fixture = await prepared({
    ...native,
    promoteStagedRun: (options) =>
      native.promoteStagedRun(
        {
          ...options,
          checkInputs: async (published) => {
            if (published?.length) controller.abort();
            await options.checkInputs(published);
          }
        },
        {
          rmSync: () => {
            throw new Error("Controlled restoration failure");
          }
        }
      )
  });
  expect(
    await fixture.adapter.promote(fixture.request, requestControl)
  ).toMatchObject({
    status: "failed",
    rollback: "incomplete"
  });
});
it("captures missing original module dependencies as incomplete rather than expected definition absence", async () => {
  await mkdir(join(root, "workspace", ".radius"));
  await writeFile(
    join(root, "workspace", ".radius", "app.bicep"),
    "module absent './missing.bicep' = {}"
  );
  expect(
    await reader.captureForAuthoring(scope, selection, control)
  ).toMatchObject({
    status: "ok",
    value: { status: "incomplete" }
  });
});
it("captures recipe outputs through the default recipe role while preserving the main definition identity", async () => {
  const snapshot = await readerSnapshot();
  const proposed = await reader.captureOverlay(
    snapshot,
    new Map([
      [".radius/app.bicep", Buffer.from("param name string")],
      [".radius/extra-recipe.bicep", Buffer.from("param name string")],
      [".radius/bicepconfig.json", Buffer.from("{}")]
    ]),
    control
  );
  expect(proposed).toMatchObject({
    status: "ok",
    value: { status: "captured" }
  });
});
it("captures expected absence only for first-model authoring without changing read absence", async () => {
  expect((await reader.capture(scope, selection, control)).status).toBe(
    "absent"
  );
  const captured = await reader.captureForAuthoring(scope, selection, control);
  expect(captured.status).toBe("ok");
  if (captured.status !== "ok" || captured.value.status !== "captured")
    throw new Error("Expected owned first-model snapshot");
  expect(captured.value.snapshot.manifest.inputs).toContainEqual({
    path: selection.definition,
    kind: "definition",
    existed: false,
    contentHash: null
  });
  expect(
    await reader.readBytes(
      captured.value.snapshot,
      selection.definition,
      control
    )
  ).toMatchObject({ status: "absent" });
});
it("owns immutable proposed binary bytes and rejects unbaselined dependencies", async () => {
  const captured = await reader.captureForAuthoring(scope, selection, control);
  if (captured.status !== "ok" || captured.value.status !== "captured")
    throw new Error("Expected snapshot");
  const bytes = new Map([
    [".radius/app.bicep", Buffer.from("param name string")],
    [".radius/bicepconfig.json", Buffer.from("{}")],
    [".radius/app.origin.json", Buffer.from("{}")]
  ]);
  const result = await reader.captureOverlay(
    captured.value.snapshot,
    bytes,
    control
  );
  if (result.status !== "ok" || result.value.status !== "captured")
    throw new Error("Expected proposal");
  bytes.set(".radius/app.bicep", Buffer.from("changed"));
  expect(
    await reader.readText(result.value.snapshot, ".radius/app.bicep", control)
  ).toMatchObject({ status: "ok", value: { text: "param name string" } });
  expect(
    await reader.readBytes(
      structuredClone(result.value.snapshot),
      ".radius/app.bicep",
      control
    )
  ).toMatchObject({ status: "unavailable" });
  bytes.set(
    ".radius/app.bicep",
    Buffer.from("var value = loadTextContent('./new.txt')")
  );
  await mkdir(join(root, "workspace", ".radius"));
  await writeFile(join(root, "workspace", ".radius", "new.txt"), "unbaselined");
  expect(
    await reader.captureOverlay(captured.value.snapshot, bytes, control)
  ).toMatchObject({ status: "ok", value: { status: "incomplete" } });
  expect(
    await readFile(join(root, "workspace", ".radius", "new.txt"), "utf8")
  ).toBe("unbaselined");
  expect(createHash("sha256").update("param name string").digest("hex")).toBe(
    result.value.snapshot.manifest.inputs
      .find((input) => input.kind === "definition")
      ?.contentHash?.slice(7)
  );
});
