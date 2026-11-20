// Errors recorded from the real clients, verbatim, so tests parse what
// production sees rather than what a fake writes. Each was recorded with a
// read-only call on 2026-11-19: aws-cli/2.37.13 against the Cloud E2E dev
// account (STS with made-up keys, so no account), gh 2.103.3 against this
// repository, and kubectl v1.32.0 against a local kind cluster. Record a new
// one the same way rather than editing these.
import type { AwsCommandResult } from "../../../src/server/services/aws-cli-session.js";

export interface RecordedError extends AwsCommandResult {
  readonly code: number;
  // The command that was run, with placeholders for local names.
  readonly command: string;
}

export const IAM_NO_SUCH_ENTITY: RecordedError = {
  command: "aws iam get-role --role-name radius-e2e-recorded-missing",
  code: 254,
  stdout: "",
  stderr:
    "\naws: [ERROR]: An error occurred (NoSuchEntity) when calling the GetRole operation: The role with name radius-e2e-recorded-missing cannot be found.\n"
};

export const EKS_UPDATE_NOT_FOUND: RecordedError = {
  command:
    "aws eks describe-update --region us-east-2 --name <cluster> --nodegroup-name default --update-id 00000000-0000-0000-0000-000000000000",
  code: 254,
  stdout: "",
  stderr:
    "\naws: [ERROR]: An error occurred (ResourceNotFoundException) when calling the DescribeUpdate operation: No update found for ID: 00000000-0000-0000-0000-000000000000\n\nAdditional error details:\nclusterName: ai-extensions-e2e-use2\nnodegroupName: default\n"
};

export const RDS_SNAPSHOT_NOT_FOUND: RecordedError = {
  command:
    "aws rds describe-db-snapshots --region us-east-2 --db-snapshot-identifier rds-snapshot-recorded-missing",
  code: 254,
  stdout: "",
  stderr:
    "\naws: [ERROR]: An error occurred (DBSnapshotNotFound) when calling the DescribeDBSnapshots operation: DBSnapshot not found: rds-snapshot-recorded-missing\n"
};

export const STS_INVALID_TOKEN: RecordedError = {
  command: "aws sts get-caller-identity, with made-up access keys",
  code: 254,
  stdout: "",
  stderr:
    "\naws: [ERROR]: An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation: The security token included in the request is invalid.\n"
};

export const GH_NOT_FOUND: RecordedError = {
  command:
    "gh api repos/radius-project/ai-extensions/environments/radtest-aws-recorded-missing",
  code: 1,
  stdout:
    '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/deployments/environments#get-an-environment","status":"404"}',
  stderr: "gh: Not Found (HTTP 404)\n"
};

export const KUBECTL_LOGS_WAITING: RecordedError = {
  command: "kubectl logs <pod> for a Job pod whose image can't be pulled",
  code: 1,
  stdout: "",
  stderr:
    'Error from server (BadRequest): container "radius-probe-default-0-run1" in pod "radius-probe-default-0-run1-tptv8" is waiting to start: trying and failing to pull image\n'
};

export const KUBECTL_FORBIDDEN: RecordedError = {
  command:
    "kubectl --as=system:serviceaccount:probe-ns:nobody -n probe-ns get jobs -o json",
  code: 1,
  stdout:
    '{\n    "apiVersion": "v1",\n    "items": [],\n    "kind": "List",\n    "metadata": {\n        "resourceVersion": ""\n    }\n}\n',
  stderr:
    'Error from server (Forbidden): jobs.batch is forbidden: User "system:serviceaccount:probe-ns:nobody" cannot list resource "jobs" in API group "batch" in the namespace "probe-ns"\n'
};

export const KUBECTL_NOT_FOUND: RecordedError = {
  command: "kubectl -n probe-ns get job radius-probe-missing -o json",
  code: 1,
  stdout: "",
  stderr:
    'Error from server (NotFound): jobs.batch "radius-probe-missing" not found\n'
};
