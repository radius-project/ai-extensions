#!/bin/bash
# Runs eks-preflight.sh offline to cover what a developer machine cannot reach
# for real: a blocked runner, a private-only cluster, bad cluster states,
# subnets outside the cluster's VPC, and a role that EKS or RBAC rejects. It
# also checks what GitHub shows: the annotation, the step outputs, the job
# summary, and the escaping of AWS error text.
#
# Fake aws, curl, and kubectl commands answer only the exact calls the script
# makes, including their timeouts and CA file. Any other call is recorded as
# unscripted and fails the case.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
export UNSCRIPTED="$tmp/unscripted" CLUSTER_JSON="$tmp/cluster.json"
ca=$(printf 'test-ca' | base64)

cat >"$tmp/bin/aws" <<'EOF'
#!/usr/bin/env bash
bounded="--cli-connect-timeout 5 --cli-read-timeout 10 --no-cli-pager"
case "$*" in
  "$bounded eks describe-cluster --region us-east-2 --name lab --output json")
    case "${FAKE_DESCRIBE:-}" in
      denied) echo "An error occurred (AccessDeniedException) when calling the DescribeCluster operation: User is not authorized to perform: eks:DescribeCluster" >&2; exit 254 ;;
      inject) printf 'Could not connect 100%%\n::warning::injected\n' >&2; exit 255 ;;
      *) cat "$CLUSTER_JSON" ;;
    esac ;;
  "$bounded ec2 describe-subnets --region us-east-2 --subnet-ids subnet-0a subnet-0b --output json")
    echo '{"Subnets":[{"SubnetId":"subnet-0a","VpcId":"vpc-1","AvailabilityZone":"us-east-2a"},{"SubnetId":"subnet-0b","VpcId":"vpc-2","AvailabilityZone":"us-east-2b"}]}' ;;
  "$bounded ec2 describe-subnets --region us-east-2 --subnet-ids subnet-0f --output json")
    echo "An error occurred (InvalidSubnetID.NotFound) when calling the DescribeSubnets operation: The subnet ID 'subnet-0f' does not exist" >&2; exit 254 ;;
  "$bounded eks get-token --region us-east-2 --cluster-name lab --output json")
    echo '{"status":{"token":"k8s-aws-v1.test"}}' ;;
  *) echo "aws $*" >>"$UNSCRIPTED"; exit 97 ;;
esac
EOF

# FAKE_API=answers returns 401, which proves the runner reached the API server.
# FAKE_API=times-out fails the way curl does when nothing answers.
cat >"$tmp/bin/curl" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == "-fsS --connect-timeout 5 --max-time 10 https://checkip.amazonaws.com" ]]; then
  echo 203.0.113.9
  exit 0
fi
probe="-sS --cacert $3 --connect-timeout 5 --max-time 10 -o /dev/null -w %{http_code} https://lab.eks.test/version"
if [[ "$*" != "$probe" || "$(cat "$3")" != test-ca ]]; then
  echo "curl $*" >>"$UNSCRIPTED"
  exit 97
fi
case "${FAKE_API:-}" in
  answers) printf 401 ;;
  times-out) printf 000; echo "curl: (28) Connection timed out after 5002 milliseconds" >&2; exit 28 ;;
  *) echo "curl $*" >>"$UNSCRIPTED"; exit 97 ;;
esac
EOF

cat >"$tmp/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" != --kubeconfig || ! -f "$2" || "$3" != --request-timeout=10s ]]; then
  echo "kubectl $*" >>"$UNSCRIPTED"
  exit 97
fi
shift 3
case "$*" in
  "version -o json")
    if [[ "${FAKE_KUBECTL:-}" == unauthorized ]]; then
      echo "error: You must be logged in to the server (Unauthorized)" >&2
      exit 1
    fi
    echo '{}' ;;
  "auth can-i "*)
    case "${FAKE_KUBECTL:-}" in
      denied) echo no; exit 1 ;;
      unreachable) echo "Unable to connect to the server: dial tcp 192.0.2.1:443: i/o timeout" >&2; exit 1 ;;
      *) echo yes ;;
    esac ;;
  *) echo "kubectl $*" >>"$UNSCRIPTED"; exit 97 ;;
esac
EOF
chmod +x "$tmp/bin/aws" "$tmp/bin/curl" "$tmp/bin/kubectl"

cluster_json() {
  # cluster_json <status> <authMode> <public> <private> <cidr>
  cat >"$CLUSTER_JSON" <<EOF
{"cluster":{"status":"$1","endpoint":"https://lab.eks.test",
 "certificateAuthority":{"data":"$ca"},
 "accessConfig":{"authenticationMode":"$2"},
 "resourcesVpcConfig":{"vpcId":"vpc-1","endpointPublicAccess":$3,"endpointPrivateAccess":$4,
  "publicAccessCidrs":["$5"]}}}
EOF
}

pass=0
failed=0
check() {
  # check <label> <condition status>
  if [[ "$2" == 0 ]]; then
    pass=$((pass + 1))
    echo "ok   $1"
  else
    failed=$((failed + 1))
    echo "FAIL $1"
    echo "$out"
  fi
}

preflight() {
  # preflight [env...] sets out and status.
  : >"$UNSCRIPTED"
  out=$(env PATH="$tmp/bin:$PATH" AWS_REGION=us-east-2 AWS_EKS_CLUSTER_NAME=lab "$@" \
    bash "$here/eks-preflight.sh" 2>&1)
  status=$?
  if [[ -s "$UNSCRIPTED" ]]; then
    out="$out
unscripted calls:
$(cat "$UNSCRIPTED")"
    status=97
  fi
}

expect_failure() {
  # expect_failure <label> <code> [env...]
  local label=$1 code=$2
  shift 2
  preflight "$@"
  [[ "$status" == 1 ]] && grep -q "^::error title=[^:]*::\[$code\] " <<<"$out"
  check "$label -> $code" $?
}

cluster_json ACTIVE API true false 198.51.100.0/24
: >"$tmp/output"
: >"$tmp/summary"
expect_failure "public only, runner outside CIDRs" EKS_ENDPOINT_NOT_ALLOWED FAKE_API=times-out \
  GITHUB_OUTPUT="$tmp/output" GITHUB_STEP_SUMMARY="$tmp/summary"
! grep -q . "$tmp/output"
check "failed run writes no step outputs" $?
grep -q '^### EKS preflight failed: Runner blocked by the EKS endpoint allow list' "$tmp/summary" &&
  grep -q '^| Cluster status | passed | [0-9]* s |$' "$tmp/summary" &&
  grep -q '^| API server connection | failed | [0-9]* s |$' "$tmp/summary" &&
  grep -qx '| Authentication | not run |  |' "$tmp/summary"
check "summary lists each check's result" $?

cluster_json ACTIVE API true true 198.51.100.0/24
expect_failure "public and private, runner outside CIDRs" EKS_ENDPOINT_NOT_ALLOWED FAKE_API=times-out
grep -qF "This cluster also has a private endpoint" <<<"$out"
check "the fix names the private endpoint" $?

cluster_json ACTIVE API false true 0.0.0.0/0
expect_failure "private only" EKS_ENDPOINT_UNREACHABLE FAKE_API=times-out
cluster_json ACTIVE API true false 203.0.113.0/24
expect_failure "runner allowed, endpoint down" EKS_ENDPOINT_UNREACHABLE FAKE_API=times-out
cluster_json DELETING API true false 0.0.0.0/0
expect_failure "cluster deleting" EKS_CLUSTER_NOT_ACTIVE
cluster_json ACTIVE CONFIG_MAP true false 0.0.0.0/0
expect_failure "aws-auth ConfigMap only" EKS_ACCESS_ENTRIES_DISABLED

cluster_json ACTIVE API true false 0.0.0.0/0
expect_failure "subnet in another VPC" AWS_SUBNET_INVALID RADIUS_SUBNET_IDS=subnet-0a,subnet-0b
expect_failure "subnet does not exist" AWS_SUBNET_INVALID RADIUS_SUBNET_IDS=subnet-0f
expect_failure "describe denied" AWS_PERMISSION_DENIED FAKE_DESCRIBE=denied
expect_failure "role has no access entry" EKS_UNAUTHORIZED FAKE_API=answers FAKE_KUBECTL=unauthorized
expect_failure "RBAC denies a write" EKS_RBAC_MISSING FAKE_API=answers FAKE_KUBECTL=denied
expect_failure "can-i request fails" EKS_ENDPOINT_UNREACHABLE FAKE_API=answers FAKE_KUBECTL=unreachable

expect_failure "AWS API unreachable" AWS_API_UNREACHABLE FAKE_DESCRIBE=inject
! grep -q '^::warning::injected' <<<"$out" && grep -q '100%25' <<<"$out"
check "AWS error text cannot start a workflow command" $?

# A passing run hands later steps the endpoint and certificate, so they need
# no second describe-cluster call.
: >"$tmp/output"
preflight FAKE_API=answers GITHUB_OUTPUT="$tmp/output"
[[ "$status" == 0 ]] && grep -qx 'endpoint=https://lab.eks.test' "$tmp/output" &&
  grep -qx "certificate-authority=$ca" "$tmp/output" && ! grep -q '::error' <<<"$out"
check "passing run writes endpoint and certificate-authority" $?

cluster_json UPDATING API true false 0.0.0.0/0
: >"$tmp/summary"
preflight FAKE_API=answers GITHUB_STEP_SUMMARY="$tmp/summary"
[[ "$status" == 0 ]] && ! grep -q '::error' <<<"$out" &&
  grep -q '^::warning title=EKS cluster is updating::\[EKS_CLUSTER_UPDATING\] ' <<<"$out" &&
  grep -q '^| Cluster status | warning | [0-9]* s |$' "$tmp/summary"
check "updating cluster that answers passes with a warning" $?

# A runner image without kubectl. The PATH holds only the commands the script
# needs before it stops, plus the fake aws and curl.
mkdir -p "$tmp/nokubectl"
for tool in aws curl; do
  ln -s "$tmp/bin/$tool" "$tmp/nokubectl/$tool"
done
for tool in bash dirname date mktemp rm tr head sed wc cat grep jq python3 base64; do
  ln -s "$(command -v "$tool")" "$tmp/nokubectl/$tool"
done
expect_failure "runner without kubectl" RUNNER_TOOL_MISSING PATH="$tmp/nokubectl"
grep -q '\[RUNNER_TOOL_MISSING\] These commands are not on the runner.s PATH: kubectl\.' <<<"$out"
check "the missing-tools message names kubectl" $?

echo "$pass passed, $failed failed"
[[ "$failed" -eq 0 ]]
