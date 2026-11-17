import {
  asRecord,
  list,
  text,
  type AwsJourneyPorts
} from "./aws-journey-support.js";
import { readAws } from "./aws-cloud-cleanup.js";

// Proves the region scope setup writes on the deploy role, with IAM's own
// policy simulator. `aws iam simulate-principal-policy` evaluates the role's
// inline and attached policies, capped by its permissions boundary, without
// sending the request:
// https://docs.aws.amazon.com/cli/latest/reference/iam/simulate-principal-policy.html
//
// An RDS and an EKS action in each live environment's region must be allowed.
// In a test region with no environment, the same actions must be denied,
// implicitly or explicitly. After the second environment is deleted, its
// region is denied again.

export const SIMULATED_ACTIONS = [
  "rds:CreateDBInstance",
  "eks:DescribeCluster"
] as const;

const DENIED = new Set(["implicitDeny", "explicitDeny"]);

export interface SimulatedDecision {
  readonly region: string;
  readonly action: string;
  readonly decision: string;
}

export interface RegionScopeCheck {
  readonly decisions: SimulatedDecision[];
  // Empty when every decision is the expected one.
  readonly failures: string[];
}

/** The simulator's `--context-entries` for one region, in the CLI's JSON form. */
export function requestedRegionContext(region: string): string {
  return JSON.stringify([
    {
      ContextKeyName: "aws:RequestedRegion",
      ContextKeyValues: [region],
      ContextKeyType: "string"
    }
  ]);
}

export async function checkDeployRoleRegionScope(
  ports: Pick<AwsJourneyPorts, "runAws">,
  input: {
    readonly roleArn: string;
    // Every region the suite uses, in order.
    readonly testRegions: readonly string[];
    // The regions of the environments that exist now.
    readonly liveRegions: readonly string[];
  }
): Promise<RegionScopeCheck> {
  const outside = input.liveRegions.filter(
    (region) => !input.testRegions.includes(region)
  );
  if (outside.length > 0)
    throw new Error(
      `Live environments are in ${outside.join(", ")}, which the check doesn't test. Test regions: ${input.testRegions.join(", ")}.`
    );
  const decisions: SimulatedDecision[] = [];
  const failures: string[] = [];
  for (const region of input.testRegions) {
    const live = input.liveRegions.includes(region);
    const results = list(
      asRecord(
        await readAws(ports, [
          "iam",
          "simulate-principal-policy",
          "--policy-source-arn",
          input.roleArn,
          "--action-names",
          ...SIMULATED_ACTIONS,
          "--context-entries",
          requestedRegionContext(region)
        ])
      )?.EvaluationResults
    ).map(asRecord);
    for (const action of SIMULATED_ACTIONS) {
      const decision = text(
        results.find((item) => text(item?.EvalActionName) === action)
          ?.EvalDecision
      );
      decisions.push({ region, action, decision });
      const expected = live ? "allowed" : "denied";
      const ok = live ? decision === "allowed" : DENIED.has(decision);
      if (ok) continue;
      failures.push(
        decision ?
          `The policy simulator gave deploy role ${input.roleArn} ${decision} for ${action} in ${region}, but expected ${expected}: ${live ? "an environment there needs it" : "no environment is there"}.`
        : `The policy simulator returned no decision for ${action} in ${region}.`
      );
    }
  }
  return { decisions, failures };
}
