import {
  findExactVerificationRun,
  hasPostDispatchVerificationRuns
} from "../../verification-run-identity.js";
import { verificationActionsUrl } from "./recovered-verification-run.js";
import type { VerificationRunListResult } from "./recovered-verification-run.js";

const DISCOVERY_DELAYS_MS = Object.freeze([0, 2000, 5000]);

export interface AutomaticVerificationIdentity {
  repo: string;
  workflow: string;
  ref: string;
  environment: string;
  operationMarker: string;
  startedAt: number;
}

export type AutomaticVerificationRunOutcome =
  | { state: "discovered"; runId: string; runUrl: string }
  | { state: "manual_required"; guidance: string }
  | { state: "cancelled" };

export async function discoverAutomaticVerificationRun(input: {
  identity: AutomaticVerificationIdentity;
  listRuns(): Promise<VerificationRunListResult>;
  stopBoundary(boundary: string): Promise<boolean>;
  sleep(milliseconds: number): Promise<void>;
}): Promise<AutomaticVerificationRunOutcome> {
  const { identity } = input;
  const actionsUrl = verificationActionsUrl(identity.repo, identity.workflow);
  const manualRequired = (reason: string): AutomaticVerificationRunOutcome => ({
    state: "manual_required",
    guidance:
      `Radius could not identify the setup branch's automatic credential verification because ${reason} ` +
      `Review ${actionsUrl}; Radius will not guess or dispatch another run.`
  });

  for (let attempt = 0; attempt < DISCOVERY_DELAYS_MS.length; attempt += 1) {
    if (
      !(await input.stopBoundary(
        `before-automatic-verification-discovery:${attempt + 1}`
      ))
    ) {
      return { state: "cancelled" };
    }
    const delay = DISCOVERY_DELAYS_MS[attempt];
    if (delay > 0) await input.sleep(delay);

    const listed = await input.listRuns();
    if (listed.code !== 0 && listed.code !== "0") {
      return manualRequired(
        `GitHub would not return the workflow runs: ${
          (listed.stderr || listed.stdout || "").trim() ||
          "the GitHub CLI request failed"
        }.`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(listed.stdout);
    } catch {
      return manualRequired("GitHub returned an unreadable workflow run list.");
    }
    const exact = findExactVerificationRun(parsed, {
      baselineRunId: null,
      dispatchedAt: identity.startedAt,
      ref: identity.ref,
      environment: identity.environment,
      operationMarker: identity.operationMarker,
      event: "push"
    });
    if (exact.state === "applied") {
      return {
        state: "discovered",
        runId: exact.runId,
        runUrl: `https://github.com/${identity.repo}/actions/runs/${exact.runId}`
      };
    }
    if (
      exact.state === "ambiguous" ||
      hasPostDispatchVerificationRuns(parsed, null, identity.startedAt)
    ) {
      return manualRequired(
        exact.state === "ambiguous" ?
          "more than one run carries the exact operation marker."
        : "a new run appeared without the exact operation marker."
      );
    }
  }
  return manualRequired("no exact operation-marked push run appeared.");
}
