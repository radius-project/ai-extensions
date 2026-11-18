import { classifyProvider } from "@radius-project/core";
import {
  applyVerificationBypass,
  inspectedEnvironmentConfig,
  type EnvironmentInspection
} from "@radius-project/core/inspection";

interface EnvironmentVerifyRun {
  status: string;
  conclusion: string;
}

export type EnvironmentInspectionRead =
  { ok: true; stdout: string } | { ok: false; error: string };

export async function inspectEnvironments(
  repo: string,
  read: (args: string[]) => Promise<EnvironmentInspectionRead>
): Promise<EnvironmentInspection> {
  const ghResult = async (args: string[]) => {
    const result = await read(args);
    return { ok: result.ok, stdout: result.ok ? result.stdout : "" };
  };
  const gh = async (args: string[]) => (await ghResult(args)).stdout;

  // 1) List environment names + ids for the repo. Kick off the
  //    verify-credentials workflow-runs fetch in parallel — it's independent
  //    of the names, so there's no reason to wait.
  const verifyRunsPromise = ghResult([
    "api",
    `/repos/${repo}/actions/workflows/radius-verify-credentials.yml/runs?per_page=100`,
    "--jq",
    '.workflow_runs[] | (.id|tostring) + "\\t" + (.status // "") + "\\t" + (.conclusion // "")'
  ]);
  const names = await read([
    "api",
    "--paginate",
    `/repos/${repo}/environments?per_page=100`,
    "--jq",
    '.environments[] | (.id|tostring) + "\\t" + .name'
  ]);
  if (!names.ok) return { kind: "unavailable", error: names.error };
  const namesRaw = names.stdout;
  const rows =
    namesRaw ?
      namesRaw
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const tab = l.indexOf("\t");
          return tab === -1 ?
              { id: "", name: l }
            : { id: l.slice(0, tab), name: l.slice(tab + 1) };
        })
    : [];
  if (rows.length === 0)
    return { kind: "listed", environments: [], hadRows: false };

  // Index the pre-fetched verify runs by run id. The environment status is
  // derived from these (not from app deployments): an environment is
  // "Success" only once it exists AND its verify-credentials workflow passed.
  const verifyRunsResult = await verifyRunsPromise;
  const verifyRunsRaw = verifyRunsResult.stdout;
  const verifyRuns = new Map<string, EnvironmentVerifyRun>();
  if (verifyRunsRaw) {
    for (const line of verifyRunsRaw.split("\n").filter(Boolean)) {
      const [rid, rstatus, rconclusion] = line.split("\t");
      verifyRuns.set(rid, { status: rstatus, conclusion: rconclusion });
    }
  }
  // Map a verify run's outcome to an environment status.
  const verifyStatusOf = (run: EnvironmentVerifyRun): string => {
    if (run.status !== "completed") return "pending"; // queued / in_progress
    if (run.conclusion === "success") return "success";
    return "failed"; // failure / cancelled / timed_out / etc.
  };
  const runLookups = new Map<
    string,
    Promise<{ ok: boolean; run: EnvironmentVerifyRun | null }>
  >();
  const lookupVerificationRun = (
    runId: string
  ): Promise<{ ok: boolean; run: EnvironmentVerifyRun | null }> => {
    const cached = runLookups.get(runId);
    if (cached) return cached;
    const lookup = ghResult([
      "api",
      `/repos/${repo}/actions/runs/${runId}`
    ]).then((result) => {
      const unavailable = { ok: false, run: null };
      if (!result.ok) return unavailable;
      let run: unknown;
      try {
        run = JSON.parse(result.stdout);
      } catch {
        return unavailable;
      }
      if (
        !run ||
        typeof run !== "object" ||
        !("path" in run) ||
        typeof run.path !== "string"
      ) {
        return unavailable;
      }
      if (run.path !== ".github/workflows/radius-verify-credentials.yml") {
        return { ok: true, run: null };
      }
      if (
        !("status" in run) ||
        typeof run.status !== "string" ||
        !run.status ||
        !("conclusion" in run) ||
        (run.conclusion !== null && typeof run.conclusion !== "string")
      ) {
        return unavailable;
      }
      return {
        ok: true,
        run: { status: run.status, conclusion: run.conclusion ?? "" }
      };
    });
    runLookups.set(runId, lookup);
    return lookup;
  };

  // 2) For each environment, derive provider (from stored variables) and a
  //    status from the verify-credentials workflow. Both the verify and deploy
  //    workflows create deployments to the same environment, so we walk this
  //    env's deployments newest-first until we find one created by a
  //    verify-credentials run.
  const environments = await Promise.all(
    rows.map(async ({ id, name }) => {
      // The variables (provider) and deployments (status) lookups are
      // independent, so fire them together.
      const [varsRaw, depIdsRaw] = await Promise.all([
        gh([
          "api",
          `/repos/${repo}/environments/${encodeURIComponent(
            name
          )}/variables?per_page=100`,
          "--jq",
          '.variables[] | .name + "\\t" + (.value // "")'
        ]),
        gh([
          "api",
          `/repos/${repo}/deployments?environment=${encodeURIComponent(
            name
          )}&per_page=10`,
          "--jq",
          ".[].id"
        ])
      ]);
      // Parse the "name<TAB>value" variable lines into a map. Only surface
      // environments created by this extension (tagged with a RADIUS_MANAGED
      // variable at creation time); anything without it was created outside
      // Radius and is filtered out below.
      const vars: Record<string, string> = {};
      for (const line of varsRaw ? varsRaw.split("\n").filter(Boolean) : []) {
        const tab = line.indexOf("\t");
        if (tab === -1) {
          vars[line] = "";
          continue;
        }
        vars[line.slice(0, tab)] = line.slice(tab + 1);
      }
      if (!("RADIUS_MANAGED" in vars)) return null;

      const provider = classifyProvider(vars);

      const credentialProfile = vars.RADIUS_CREDENTIAL_PROFILE || "";

      // A successful verification lookup plus existing deployments proves
      // this is an established environment even when the verification
      // deployment itself has aged out of the bounded history. Lookup
      // failures and environments with no deployments fail closed as pending.
      const depIds = depIdsRaw ? depIdsRaw.split("\n").filter(Boolean) : [];
      let status =
        verifyRunsResult.ok && depIds.length > 0 ? "unknown" : "pending";
      // The run id that determined `status`, so a bypass marker can be matched
      // to the specific failed run it was granted for rather than overriding
      // any later or unrelated failure.
      let matchedRunId = "";
      if (verifyRunsResult.ok) {
        // Resolve every deployment's originating-run URL in parallel
        // (deployments come back newest-first), then pick the newest one
        // created by a verify-credentials run. Doing this serially was the
        // main source of latency for this endpoint.
        const logResults = await Promise.all(
          depIds.map((depId) =>
            ghResult([
              "api",
              `/repos/${repo}/deployments/${depId}/statuses?per_page=1`,
              "--jq",
              '.[0].log_url // .[0].target_url // ""'
            ])
          )
        );
        if (logResults.some((result) => !result.ok)) {
          status = "pending";
        } else {
          const runIds: string[] = [];
          for (const { stdout: logUrl } of logResults) {
            const m = /actions\/runs\/(\d+)/.exec(logUrl || "");
            if (!m) continue;
            runIds.push(m[1]);
            const run = verifyRuns.get(m[1]);
            if (run) {
              status = verifyStatusOf(run);
              matchedRunId = m[1];
              break;
            }
          }
          if (!matchedRunId) {
            // Only these ten deployments can affect this environment. Read
            // their runs in parallel instead of paging all repository history.
            const runs = await Promise.all(runIds.map(lookupVerificationRun));
            for (const [index, result] of runs.entries()) {
              if (!result.ok) {
                status = "pending";
                break;
              }
              if (result.run) {
                status = verifyStatusOf(result.run);
                matchedRunId = runIds[index];
                break;
              }
            }
          }
        }
      }

      // A user who kept an environment despite a failed verification (4.4 /
      // 4.5) leaves this durable marker, whose value is the run id that
      // failed. Surface "bypassed" only when the current status is a failure
      // of that exact run: a real later "success" wins on its own, and a
      // different later failure (a new run id) is not silently inherited but
      // reported as failed so it is re-examined.
      status = applyVerificationBypass(
        status,
        matchedRunId,
        vars.RADIUS_VERIFICATION_BYPASSED
      );

      const webUrl =
        id ?
          `https://github.com/${repo}/settings/environments/${id}/edit`
        : `https://github.com/${repo}/settings/environments`;
      // The environment's own configuration, so Edit can reopen the creation
      // form on what this environment actually holds instead of sending the
      // user to GitHub's settings page. Only the fields the form asks for:
      // identity and subscription come from the credential profile, and no
      // secret is stored as a variable in the first place.
      const config = inspectedEnvironmentConfig(vars, provider);
      return { name, provider, status, webUrl, credentialProfile, config };
    })
  );

  const managedEnvironments = environments.filter(
    (environment): environment is NonNullable<typeof environment> =>
      environment !== null
  );
  return { kind: "listed", environments: managedEnvironments, hadRows: true };
}
