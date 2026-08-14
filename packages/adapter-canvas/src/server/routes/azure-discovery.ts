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

// Only three seams. `runAz` is the sole I/O: it is `runCliCommand` bound at the
// composition root, which is what carries the agent-session-stripped `cliExec`
// environment these Azure routes must keep running under. The other two are the
// pure `azure-oidc.ts` predicates, injected rather than imported so the handler
// stays free of module-level coupling and the tests can drive each branch.
export interface AzureDiscoveryDependencies {
  runAz(command: string, args: string[]): Promise<AzureCommandResult>;
  isUuid(value: unknown): boolean;
  parseServedReposFromSubjects(subjects: unknown): string[];
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export function createAzureDiscoveryRoutes(
  dependencies: AzureDiscoveryDependencies
): RouteHandlerRegistry {
  return {
    "GET /api/list-azure-app-registrations": (context) =>
      handleListAzureAppRegistrations(context, dependencies),
    "GET /api/azure-app-serves-repos": (context) =>
      handleAzureAppServesRepos(context, dependencies)
  };
}
