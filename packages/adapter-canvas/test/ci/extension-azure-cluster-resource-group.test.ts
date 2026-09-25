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

/**
 * The lines that actually pass `--resource-group`, with comments dropped.
 *
 * A YAML comment mentioning a variable is documentation, not an argument, and
 * these steps carry comments naming both variables precisely because the
 * distinction is easy to get wrong.
 */
function resourceGroupArguments(source: string): string[] {
  return source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .filter((line) => line.includes("--resource-group"));
}

/** The value an `env:` entry binds, for the steps that avoid interpolation. */
function environmentBinding(source: string, name: string): string | null {
  const match = source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .find((line) => line.trimStart().startsWith(`${name}:`));
  return match ? match.slice(match.indexOf(":") + 1).trim() : null;
}

/**
 * The expression a `--resource-group` argument ultimately resolves to.
 *
 * Two shapes are legitimate. The argument either carries the expression
 * directly, or it reads a shell variable that an `env:` entry bound to the
 * expression — which is how `delete-environment-azure.yml` keeps
 * environment-controlled values out of its shell source.
 *
 * Following the indirection is what makes this answer the question being
 * asked. Reading the argument line alone would see `"$AZURE_AKS_RESOURCE_GROUP"`
 * and stop, without ever learning which group that name was bound to.
 *
 * Resolution deliberately starts from the argument rather than from the file,
 * so an `env:` binding belonging to some other step is not mistaken for part of
 * the cluster lookup. Hardening an unrelated step the same way is a change this
 * test has no business failing.
 *
 * `null` means the shape was not recognised, which the callers treat as a
 * failure rather than a pass: an argument this cannot read is one it cannot
 * vouch for.
 */
function resolvedResourceGroup(
  source: string,
  argument: string
): string | null {
  const interpolated = /--resource-group\s+"(\$\{\{.*?\}\})"/.exec(argument);
  if (interpolated) return interpolated[1];
  const shellVariable = /--resource-group\s+"\$([A-Za-z_][A-Za-z0-9_]*)"/.exec(
    argument
  );
  if (shellVariable) return environmentBinding(source, shellVariable[1]);
  return null;
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
      const args = resourceGroupArguments(source);
      expect(args.length).toBeGreaterThan(0);
      for (const argument of args) {
        expect(resolvedResourceGroup(source, argument)).toBe(
          CLUSTER_RESOURCE_GROUP
        );
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
      for (const argument of resourceGroupArguments(source)) {
        expect(resolvedResourceGroup(source, argument)).not.toBe(
          APPLICATION_RESOURCE_GROUP
        );
      }
    }
  );
});

describe("the generated Azure workflows' application resource group", () => {
  // The opposite substitution, which would move where an application's
  // resources are created rather than break a lookup.
  it.each([
    ["the environment's Azure provider", "resourceGroupName:"],
    [
      "the recipe pack's parameter",
      "append_pack_parameter_if_declared azureResourceGroup"
    ]
  ])("keeps %s on the application's resource group", (_label, marker) => {
    const uses = workflows
      .flatMap(([, source]) => source.split(/\r?\n/))
      .filter((line) => line.includes(marker));

    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line).toContain("vars.AZURE_RESOURCE_GROUP");
      expect(line).not.toContain("AZURE_AKS_RESOURCE_GROUP");
    }
  });
});
