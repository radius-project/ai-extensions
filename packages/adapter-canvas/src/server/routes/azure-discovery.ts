import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";

// Shaped exactly like the `runCliCommand` result in `server.ts`. Reproduced
// structurally rather than imported because that interface is module-local to
// the composition root, and widening its visibility would couple this module to
// the facade it is being extracted from. `code` really is `string | number`:
// Node reports a spawn failure as an errno string, and both routes compare it
// to the number 0, so a string code is a failure to them.
export interface AzureCommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
}

export interface AzureAppRegistration {
  appId: unknown;
  displayName: unknown;
  createdDateTime: unknown;
}

export interface DiscoveryItem {
  id: string;
  name: string;
  resourceGroup?: string;
}

export interface DiscoveryResult {
  clusters: DiscoveryItem[];
  resourceGroups: DiscoveryItem[];
  namespaces: string[];
  vpcs: DiscoveryItem[];
  subnets: DiscoveryItem[];
  errors?: Record<string, string>;
}

// Four seams, both of them I/O. `runAz` is `runCliCommand` bound at the
// composition root, which is what carries the agent-session-stripped `cliExec`
// environment these Azure routes must keep running under; `runCli` is the
// separate `gh.ts` `runCommand` runner that resolves trimmed stdout and rejects
// on a non-zero exit, which is the shape `/api/discover` branches on. The other
// two are the pure `azure-oidc.ts` predicates, injected rather than imported so
// the handler stays free of module-level coupling and the tests can drive each
// branch.
export interface AzureDiscoveryDependencies {
  runAz(command: string, args: string[]): Promise<AzureCommandResult>;
  runCli(
    command: string,
    args: string[],
    options: { timeout: number }
  ): Promise<string>;
  isUuid(value: unknown): boolean;
  parseServedReposFromSubjects(subjects: unknown): string[];
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value));
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Pure projection of an `az`/`aws` JSON array into the picker's item shape.
// Kept module-internal rather than injected: it touches nothing but its
// argument, so a test double for it could only diverge from production.
function discoveryItems(value: unknown): DiscoveryItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const fields = record(item);
    return {
      id: optionalString(fields.id),
      name: optionalString(fields.name),
      resourceGroup: optionalString(fields.resourceGroup)
    };
  });
}

// List all App Registrations owned by the signed-in user. Backs the opt-in "use
// an existing application" cross-repo picker on the Environment page.
//
// `--show-mine` scopes the query to apps the signed-in user owns, so the picker
// avoids an O(N) owner lookup across the whole tenant.
//
// The projection is deliberately narrow: `servesRepos` (which repos an app
// already deploys) needs one `az ad app federated-credential list` per app, so
// computing it here made the picker block on N process spawns before any row
// rendered. The client lazy-loads that label per row from
// /api/azure-app-serves-repos instead.
export async function handleListAzureAppRegistrations(
  context: CanvasRequestContext,
  dependencies: AzureDiscoveryDependencies
): Promise<void> {
  try {
    const listRes = await dependencies.runAz("az", [
      "ad",
      "app",
      "list",
      "--show-mine",
      "--query",
      "[].{appId:appId,displayName:displayName,createdDateTime:createdDateTime}",
      "-o",
      "json"
    ]);
    if (listRes.code !== 0) {
      context.json(400, {
        error: "Failed to list App Registrations: " + listRes.stderr,
        code: "app-list-failed",
        azError: listRes.stderr
      });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(listRes.stdout);
    } catch {
      parsed = null;
    }
    // A non-array payload and unparsable output share one response: both mean
    // the CLI answered successfully with something the picker cannot render.
    if (!Array.isArray(parsed)) {
      context.json(400, {
        error: "The App Registration list returned an unexpected result.",
        code: "app-list-parse"
      });
      return;
    }
    const apps = parsed
      .filter((entry) => Boolean(record(entry).appId))
      .map<AzureAppRegistration>((entry) => {
        const app = record(entry);
        return {
          appId: app.appId,
          displayName: app.displayName,
          createdDateTime: app.createdDateTime
        };
      });
    context.json(200, { apps });
  } catch (e) {
    context.json(400, { error: errorMessage(e), code: "app-list-failed" });
  }
}

// Lazy per-app companion to /api/list-azure-app-registrations: computes the
// "already serves" repo label for ONE App Registration from its
// federated-credential subjects. Best-effort by design — any CLI or parse
// failure yields a null label rather than an error the picker row would have to
// surface. Only a malformed appId is reported as an error, because that is a
// caller bug rather than an absent label.
export async function handleAzureAppServesRepos(
  context: CanvasRequestContext,
  dependencies: AzureDiscoveryDependencies
): Promise<void> {
  const appId = context.url.searchParams.get("appId") || "";
  if (!dependencies.isUuid(appId)) {
    context.json(400, {
      error: "A valid appId is required.",
      code: "app-serves-bad-id"
    });
    return;
  }
  // Unlike the list route this one has no surrounding try/catch, so a rejecting
  // runner propagates to the dispatcher instead of becoming a 400.
  let servesRepos: string[] | null = null;
  const ficRes = await dependencies.runAz("az", [
    "ad",
    "app",
    "federated-credential",
    "list",
    "--id",
    appId,
    "--query",
    "[].subject",
    "-o",
    "json"
  ]);
  if (ficRes.code === 0) {
    try {
      servesRepos =
        dependencies.parseServedReposFromSubjects(JSON.parse(ficRes.stdout)) ||
        null;
    } catch {
      servesRepos = null;
    }
  }
  context.json(200, { servesRepos });
}

// Enumerates the cloud resources the Environment page offers as choices. Every
// arm of this route answers 200: a discovery failure is reported as a partial
// result carrying a per-facet `errors` entry, because the page renders whatever
// it could enumerate rather than failing the whole panel.
export async function handleDiscover(
  context: CanvasRequestContext,
  dependencies: AzureDiscoveryDependencies
): Promise<void> {
  // Read outside the try, exactly as the legacy arm did: a stream failure
  // propagates to the dispatcher instead of becoming the 200 error payload.
  const body = await context.readTextBody();
  try {
    // Deliberately not normalized through a `record()` guard: a body of `null`
    // or a bare scalar makes the property reads below throw, and the throw
    // lands in the catch, which is the legacy behavior.
    const data = JSON.parse(body) as {
      subscriptionId?: string;
      provider?: string;
    };
    const result: DiscoveryResult = {
      clusters: [],
      resourceGroups: [],
      namespaces: [],
      vpcs: [],
      subnets: []
    };

    // Reject a non-GUID subscriptionId before it reaches the az argv.
    // On Windows cliExec routes az through `cmd.exe /c` and libuv only
    // quotes args with whitespace, so "x&calc" would be split by cmd.exe
    // as a command separator. Empty is allowed (ambient CLI context).
    if (
      data.subscriptionId &&
      !dependencies.isUuid(String(data.subscriptionId).trim())
    ) {
      context.json(200, {
        error: `Invalid subscriptionId "${data.subscriptionId}" (expected a GUID).`,
        clusters: [],
        resourceGroups: [],
        namespaces: ["default"],
        vpcs: [],
        subnets: []
      });
      return;
    }

    if (data.provider === "azure") {
      // Set tenant/subscription context before querying
      if (data.subscriptionId) {
        try {
          await dependencies.runCli(
            "az",
            ["account", "set", "--subscription", data.subscriptionId],
            { timeout: 10000 }
          );
        } catch {
          // Best-effort: an unselectable subscription still gets queried below
          // with an explicit `--subscription` argument.
        }
      }
      const subArgs =
        data.subscriptionId ? ["--subscription", data.subscriptionId] : [];
      try {
        const aksJson = await dependencies.runCli(
          "az",
          [
            "aks",
            "list",
            "--query",
            "[].{id:name, name:name, resourceGroup:resourceGroup}",
            "-o",
            "json",
            ...subArgs
          ],
          { timeout: 30000 }
        );
        result.clusters = discoveryItems(JSON.parse(aksJson));
      } catch (e) {
        result.clusters = [];
        result.errors = result.errors || {};
        result.errors.clusters = errorMessage(e).slice(0, 800);
      }
      try {
        const rgJson = await dependencies.runCli(
          "az",
          [
            "group",
            "list",
            "--query",
            "[].{id:name, name:name}",
            "-o",
            "json",
            ...subArgs
          ],
          { timeout: 30000 }
        );
        result.resourceGroups = discoveryItems(JSON.parse(rgJson));
      } catch (e) {
        result.resourceGroups = [];
        result.errors = result.errors || {};
        result.errors.resourceGroups = errorMessage(e).slice(0, 800);
      }
      // If we got a cluster, try to get namespaces from it
      if (result.clusters.length > 0) {
        try {
          const rg =
            result.resourceGroups.length > 0 ? result.resourceGroups[0].id : "";
          const clusterName = result.clusters[0].id;
          if (rg && clusterName) {
            await dependencies.runCli(
              "az",
              [
                "aks",
                "get-credentials",
                "--name",
                clusterName,
                "--resource-group",
                rg,
                "--overwrite-existing"
              ],
              { timeout: 20000 }
            );
            const nsJson = await dependencies.runCli(
              "kubectl",
              ["get", "namespaces", "-o", "jsonpath={.items[*].metadata.name}"],
              { timeout: 10000 }
            );
            result.namespaces = nsJson
              .replace(/"/g, "")
              .split(" ")
              .filter(Boolean);
          } else {
            result.namespaces = ["default", "kube-system", "radius-system"];
          }
        } catch {
          result.namespaces = ["default", "kube-system", "radius-system"];
        }
      } else {
        result.namespaces = ["default", "kube-system", "radius-system"];
      }
    } else {
      try {
        const eksJson = await dependencies.runCli(
          "aws",
          ["eks", "list-clusters", "--query", "clusters", "--output", "json"],
          { timeout: 15000 }
        );
        const clusterNames: unknown = JSON.parse(eksJson);
        result.clusters =
          Array.isArray(clusterNames) ?
            clusterNames
              .filter((name): name is string => typeof name === "string")
              .map((name) => ({ id: name, name }))
          : [];
      } catch (e) {
        result.clusters = [];
        result.errors = result.errors || {};
        result.errors.clusters = errorMessage(e).slice(0, 800);
      }
      try {
        const vpcJson = await dependencies.runCli(
          "aws",
          [
            "ec2",
            "describe-vpcs",
            "--query",
            "Vpcs[].{id:VpcId, name:VpcId}",
            "--output",
            "json"
          ],
          { timeout: 15000 }
        );
        result.vpcs = discoveryItems(JSON.parse(vpcJson));
      } catch (e) {
        result.vpcs = [];
        result.errors = result.errors || {};
        result.errors.vpcs = errorMessage(e).slice(0, 800);
      }
      try {
        const subnetJson = await dependencies.runCli(
          "aws",
          [
            "ec2",
            "describe-subnets",
            "--query",
            "Subnets[].{id:SubnetId, name:SubnetId}",
            "--output",
            "json"
          ],
          { timeout: 15000 }
        );
        result.subnets = discoveryItems(JSON.parse(subnetJson));
      } catch (e) {
        result.subnets = [];
        result.errors = result.errors || {};
        result.errors.subnets = errorMessage(e).slice(0, 800);
      }
      result.namespaces = ["default", "kube-system", "radius-system"];
    }

    context.json(200, result);
  } catch (e) {
    context.json(200, {
      error: errorMessage(e),
      clusters: [],
      resourceGroups: [],
      namespaces: ["default"],
      vpcs: [],
      subnets: []
    });
  }
}

export function createAzureDiscoveryRoutes(
  dependencies: AzureDiscoveryDependencies
): RouteHandlerRegistry {
  return {
    "GET /api/list-azure-app-registrations": (context) =>
      handleListAzureAppRegistrations(context, dependencies),
    "GET /api/azure-app-serves-repos": (context) =>
      handleAzureAppServesRepos(context, dependencies),
    "POST /api/discover": (context) => handleDiscover(context, dependencies)
  };
}
