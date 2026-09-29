// Which resource group the generated Azure workflows look the AKS cluster up
// in.
//
// An AKS cluster is addressed by subscription, resource group, and name, so
// `az aks get-credentials --resource-group` names the group the cluster itself
// lives in. That is `AZURE_AKS_RESOURCE_GROUP`. It is not
// `AZURE_RESOURCE_GROUP`, which is where the application's own resources are
// created: the same variable is passed to the environment's
// `providers.azure.resourceGroupName` and to the recipe pack's
// `azureResourceGroup` parameter, and Radius does not require an application to
// deploy into the group its cluster happens to sit in.
//
// The two are equal for every environment the wizard creates today, so a
// workflow that confuses them still works and no run would report this. These
// assertions are the only thing standing between that and a deploy, verify, or
// delete that cannot find the cluster the moment the two values diverge.
//
// Both directions are pinned, because either substitution is silent:
//
//   A cluster lookup that reads the application's group finds no cluster.
//   An application value that reads the cluster's group provisions the
//   application's resources into the wrong group.
//
// The files are discovered rather than listed, so a new Azure workflow that
// connects to a cluster is held to the same rule instead of being missed.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const EXTENSION_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.github/extension"
);

const CLUSTER_COMMAND = "az aks get-credentials";

// The cluster's group, falling back to the application's. The fallback is
// required rather than tidy: an environment created before
// `AZURE_AKS_RESOURCE_GROUP` was written holds no such variable, and GitHub
// resolves an absent one to the empty string. Without the fallback every one of
// those environments would call `az` with an empty `--resource-group`. Radius
// re-publishes drifted workflow files into repositories it already set up, so
// this reaches those environments without their variables changing.
const CLUSTER_RESOURCE_GROUP =
  "${{ vars.AZURE_AKS_RESOURCE_GROUP || vars.AZURE_RESOURCE_GROUP }}";

// Where the application's resources are created. Unqualified on purpose: this
// one must not acquire the fallback above.
const APPLICATION_RESOURCE_GROUP = "${{ vars.AZURE_RESOURCE_GROUP }}";

async function readExtensionWorkflows(): Promise<
  ReadonlyArray<readonly [string, string]>
> {
  const names = (await readdir(EXTENSION_DIRECTORY)).filter((name) =>
    name.endsWith(".yml")
  );
  return Promise.all(
    names.map(
      async (name) =>
        [
          name,
          await readFile(path.join(EXTENSION_DIRECTORY, name), "utf8")
        ] as const
    )
  );
}

const workflows = await readExtensionWorkflows();

const clusterWorkflows = workflows.filter(([, source]) =>
  source.includes(CLUSTER_COMMAND)
);

interface WorkflowStep {
  readonly name?: string;
  readonly run?: unknown;
  readonly env?: Record<string, unknown>;
}

interface WorkflowJob {
  readonly env?: Record<string, unknown>;
  readonly steps?: readonly WorkflowStep[];
}

interface Workflow {
  readonly env?: Record<string, unknown>;
  readonly jobs?: Record<string, WorkflowJob>;
}

/**
 * A `run:` script paired with the environment its own step can see.
 *
 * Scope is what makes the resolution below mean anything. A binding declared on
 * some other step is not in this step's environment, so reading the file as one
 * flat namespace would accept a workflow whose cluster lookup is bound to
 * nothing — the shell would expand an unset name to the empty string and `az`
 * would be called with no resource group at all.
 *
 * Workflow, job and step `env:` are merged in that order, matching how GitHub
 * Actions layers them.
 */
interface ScopedScript {
  readonly step: string;
  readonly script: string;
  readonly environment: Record<string, string>;
}

function stringEntries(
  source: Record<string, unknown> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function scopedScripts(source: string): ScopedScript[] {
  const parsed = parse(source) as Workflow | null;
  const workflowEnv = stringEntries(parsed?.env);
  const found: ScopedScript[] = [];
  for (const job of Object.values(parsed?.jobs ?? {})) {
    const jobEnv = stringEntries(job?.env);
    for (const step of job?.steps ?? []) {
      if (typeof step?.run !== "string") continue;
      found.push({
        step: step.name ?? "(unnamed)",
        script: step.run,
        environment: {
          ...workflowEnv,
          ...jobEnv,
          ...stringEntries(step.env)
        }
      });
    }
  }
  return found;
}

/**
 * The expression a reference ultimately resolves to.
 *
 * Two shapes are legitimate. The text either carries the expression directly,
 * or it reads a shell variable that an `env:` entry bound to the expression —
 * which is how these workflows keep environment-controlled values out of their
 * shell source.
 *
 * Following the indirection is what makes this answer the question being
 * asked. Reading the text alone would see `"$AZURE_AKS_RESOURCE_GROUP"` and
 * stop, without ever learning which group that name was bound to.
 *
 * `null` means the shape was not recognised, which the callers treat as a
 * failure rather than a pass: a reference this cannot read is one it cannot
 * vouch for.
 */
function resolveReference(
  environment: Record<string, string>,
  text: string
): string | null {
  const interpolated = /(\$\{\{.*?\}\})/.exec(text);
  if (interpolated) return interpolated[1];
  const shellVariable = /\$([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
  if (shellVariable) return environment[shellVariable[1]] ?? null;
  return null;
}

/** Every `--resource-group` argument in a script, resolved against its step. */
function resolvedResourceGroups(script: ScopedScript): (string | null)[] {
  return [...script.script.matchAll(/--resource-group\s+"([^"]+)"/g)].map(
    (match) => resolveReference(script.environment, match[1])
  );
}

describe("the generated Azure workflows' AKS cluster lookup", () => {
  // Guards the discovery itself: a rename that emptied this list would leave
  // every assertion below vacuously true.
  it("finds the workflows that connect to a cluster", () => {
    expect(clusterWorkflows.map(([name]) => name).sort()).toEqual([
      "delete-azure.yml",
      "delete-environment-azure.yml",
      "run-rad-commands-azure.yml",
      "verify-azure.yml"
    ]);
  });

  it.each(clusterWorkflows)(
    "%s looks the cluster up in the cluster's own resource group",
    (_name, source) => {
      const resolved = scopedScripts(source).flatMap(resolvedResourceGroups);
      expect(resolved.length).toBeGreaterThan(0);
      for (const group of resolved) {
        expect(group).toBe(CLUSTER_RESOURCE_GROUP);
      }
    }
  );

  // The failure this pins is the tempting one: reading the application's group
  // directly looks correct and works everywhere it is currently tested. Named
  // separately from the assertion above, which it follows from, so the most
  // likely regression reports itself rather than as an expression mismatch.
  it.each(clusterWorkflows)(
    "%s never resolves the cluster from the application's resource group alone",
    (_name, source) => {
      for (const group of scopedScripts(source).flatMap(
        resolvedResourceGroups
      )) {
        expect(group).not.toBe(APPLICATION_RESOURCE_GROUP);
      }
    }
  );

  // A binding on another step is not in this step's environment, so a lookup
  // that reads an unbound name must fail rather than resolve through the file.
  // The shell would expand it to the empty string and call `az` with no
  // resource group at all.
  it("refuses a lookup whose binding belongs to another step", () => {
    const source = [
      "jobs:",
      "  deploy:",
      "    steps:",
      "      - name: Unrelated",
      "        env:",
      `          AZURE_AKS_RESOURCE_GROUP: ${CLUSTER_RESOURCE_GROUP}`,
      "        run: echo unrelated",
      "      - name: Connect to AKS cluster",
      "        run: |",
      '          az aks get-credentials --resource-group "$AZURE_AKS_RESOURCE_GROUP"'
    ].join("\n");

    expect(scopedScripts(source).flatMap(resolvedResourceGroups)).toEqual([
      null
    ]);
  });

  // Job-level `env:` is in scope for every step in the job, so a binding
  // declared there resolves rather than failing.
  it("resolves a lookup through a job-level binding", () => {
    const source = [
      "jobs:",
      "  deploy:",
      "    env:",
      `      AZURE_AKS_RESOURCE_GROUP: ${CLUSTER_RESOURCE_GROUP}`,
      "    steps:",
      "      - name: Connect to AKS cluster",
      "        run: |",
      '          az aks get-credentials --resource-group "$AZURE_AKS_RESOURCE_GROUP"'
    ].join("\n");

    expect(scopedScripts(source).flatMap(resolvedResourceGroups)).toEqual([
      CLUSTER_RESOURCE_GROUP
    ]);
  });
});

describe("the generated Azure workflows' application resource group", () => {
  // The opposite substitution, which would move where an application's
  // resources are created rather than break a lookup.
  //
  // Resolved rather than matched literally, so the assertion keeps holding
  // once a value reaches the shell through an `env:` binding instead of being
  // interpolated. What matters is which group the value ends up being, not the
  // shape it travels in.
  it.each([
    ["the environment's Azure provider", "resourceGroupName:"],
    [
      "the recipe pack's parameter",
      "append_pack_parameter_if_declared azureResourceGroup"
    ]
  ])("keeps %s on the application's resource group", (_label, marker) => {
    const uses = workflows.flatMap(([, source]) =>
      scopedScripts(source).flatMap((script) =>
        script.script
          .split(/\r?\n/)
          .filter((line) => line.includes(marker))
          .map((line) => [script.environment, line] as const)
      )
    );

    expect(uses.length).toBeGreaterThan(0);
    for (const [environment, line] of uses) {
      expect(resolveReference(environment, line)).toBe(
        APPLICATION_RESOURCE_GROUP
      );
    }
  });
});
