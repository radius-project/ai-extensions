#!/bin/bash
# Read-only EKS preflight for the AWS workflows.
#
# It answers one question in seconds: can this runner reach and use the target
# EKS cluster? It reports the answer in three places:
#   - One GitHub annotation per problem. The title is a short summary and the
#     message starts with a stable code, for example
#     "::error title=Runner blocked by the EKS endpoint allow list::[EKS_ENDPOINT_NOT_ALLOWED] ...".
#     The GitHub UI shows it, and the check-run annotations API returns it.
#   - A job summary with one row per check, when GITHUB_STEP_SUMMARY is set.
#   - On success, the cluster's endpoint and base64 certificate-authority in
#     GITHUB_OUTPUT, so later steps need no describe-cluster call.
#
# Inputs (environment). The workflows check their shape first, in Validate inputs.
#   AWS_REGION, AWS_EKS_CLUSTER_NAME   required
#   RADIUS_SUBNET_IDS                  optional; checks the subnets exist in the cluster's VPC
#
# Needs aws, jq, curl, kubectl, python3, and base64 on PATH.
# Exit codes: 0 pass, 1 failure.
# Makes no changes. kubectl auth can-i sends SelfSubjectAccessReview requests,
# which the API server evaluates without storing anything.
set -uo pipefail

started=$(date +%s)
work=$(mktemp -d)

# Checks in the order they run. A check is passed, warning, failed, skipped, or not run.
check_names=("Tools" "Cluster status" "Subnets" "API server connection" "Authentication" "Kubernetes permissions")
check_state=("not run" "not run" "not run" "not run" "not run" "not run")
check_secs=("" "" "" "" "" "")
current=-1
current_start=0
failure_code=""
failure_title=""
failure_text=""
failure_fix=""
endpoint=""
ca_data=""

# shellcheck source=.github/extension/scripts/workflow-annotations.sh
source "$(dirname "${BASH_SOURCE[0]}")/../../scripts/workflow-annotations.sh"

begin() {
  current=$1
  current_start=$(date +%s)
}

finish() {
  ((current >= 0)) || return 0
  # A warning raised during a check stays visible when the check passes.
  if [[ "$1" != passed || "${check_state[$current]}" != warning ]]; then
    check_state[current]=$1
  fi
  check_secs[current]=$(($(date +%s) - current_start))
}

warn() {
  # warn <CODE> <title> <message>
  annotate warning "$@"
  if ((current >= 0)); then check_state[current]=warning; fi
}

fail() {
  # fail <CODE> <title> <message> <fix>
  failure_code=$1 failure_title=$2 failure_text=$3 failure_fix=${4:-}
  annotate error "$@"
  finish failed
  exit 1
}

report() {
  local status=$? total i
  total=$(($(date +%s) - started))
  if [[ "$status" -ne 0 && -z "$failure_code" ]]; then
    # A bug in this script, not a finding about the cluster.
    failure_code=PREFLIGHT_ERROR failure_title="Preflight script error"
    failure_text="The preflight stopped with exit status $status before it finished."
    failure_fix="Rerun the workflow. If it fails again, report the run to the Radius maintainers."
    annotate error "$failure_code" "$failure_title" "$failure_text" "$failure_fix"
    finish failed
  fi
  if [[ -z "$failure_code" && -n "${GITHUB_OUTPUT:-}" ]]; then
    printf 'endpoint=%s\ncertificate-authority=%s\n' "$endpoint" "$ca_data" >>"$GITHUB_OUTPUT"
  fi
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      if [[ -n "$failure_code" ]]; then
        printf '### EKS preflight failed: %s\n\n%s\n\n' "$failure_title" "$failure_text"
        [[ -z "$failure_fix" ]] || printf '**Fix:** %s\n\n' "$failure_fix"
        printf "Code: \`%s\`. Nothing was changed.\n\n" "$failure_code"
      else
        printf '### EKS preflight passed in %s s\n\n' "$total"
      fi
      echo '| Check | Result | Time |'
      echo '| --- | --- | --- |'
      for i in "${!check_names[@]}"; do
        printf '| %s | %s | %s |\n' "${check_names[$i]}" "${check_state[$i]}" "${check_secs[$i]:+${check_secs[$i]} s}"
      done
      echo
    } >>"$GITHUB_STEP_SUMMARY"
  fi
  if [[ -n "$failure_code" ]]; then
    echo "preflight failed after ${total}s" >&2
  else
    echo "preflight passed in ${total}s"
  fi
  rm -rf "$work"
  exit "$status"
}
trap report EXIT

err_text() {
  # The first 300 bytes of the last AWS CLI error, on one line.
  head -c 300 "$work/err" | tr '\r\n' '  ' | sed 's/^ *//'
}

aws_ro() {
  aws --cli-connect-timeout 5 --cli-read-timeout 10 --no-cli-pager "$@"
}

region="${AWS_REGION:-}"
cluster="${AWS_EKS_CLUSTER_NAME:-}"
subnets="${RADIUS_SUBNET_IDS:-}"

# 1. Tools. A self-hosted runner image may not have every tool that
# ubuntu-24.04 includes.
begin 0
missing_tools=""
for tool in aws jq curl kubectl python3 base64; do
  command -v "$tool" >/dev/null 2>&1 || missing_tools="$missing_tools $tool"
done
[[ -z "$missing_tools" ]] ||
  fail RUNNER_TOOL_MISSING "Runner is missing tools" "These commands are not on the runner's PATH:$missing_tools." \
    "Install them on the runner image, or run the workflow on ubuntu-24.04, which includes them."
finish passed

# 2. Control-plane state from the EKS API.
begin 1
if ! aws_ro eks describe-cluster --region "$region" --name "$cluster" \
  --output json >"$work/cluster.json" 2>"$work/err"; then
  if grep -q ResourceNotFoundException "$work/err"; then
    fail EKS_CLUSTER_NOT_FOUND "EKS cluster not found" "EKS cluster '$cluster' does not exist in $region." \
      "Check AWS_EKS_CLUSTER_NAME and AWS_REGION in this GitHub environment's variables."
  elif grep -qE 'AccessDenied|not authorized' "$work/err"; then
    fail AWS_PERMISSION_DENIED "AWS permission denied" "The deploy role cannot call eks:DescribeCluster on '$cluster' in $region: $(err_text)" \
      "Rerun environment setup to restore the deploy role's permissions."
  fi
  fail AWS_API_UNREACHABLE "AWS API unreachable" "eks:DescribeCluster failed: $(err_text)" \
    "Rerun the workflow. If it fails again, check the AWS service health for $region."
fi

status=$(jq -r '.cluster.status' "$work/cluster.json")
endpoint=$(jq -r '.cluster.endpoint // empty' "$work/cluster.json")
public=$(jq -r '.cluster.resourcesVpcConfig.endpointPublicAccess' "$work/cluster.json")
private=$(jq -r '.cluster.resourcesVpcConfig.endpointPrivateAccess' "$work/cluster.json")
auth_mode=$(jq -r '.cluster.accessConfig.authenticationMode // "CONFIG_MAP"' "$work/cluster.json")
jq -r '.cluster.resourcesVpcConfig.publicAccessCidrs[]?' "$work/cluster.json" >"$work/cidrs"

# An UPDATING cluster keeps serving the Kubernetes API during version and
# configuration updates, so warn and let the reachability checks decide.
case "$status" in
  ACTIVE) ;;
  UPDATING)
    warn EKS_CLUSTER_UPDATING "EKS cluster is updating" "EKS cluster '$cluster' is UPDATING. The run continues, but requests can fail while the update runs."
    ;;
  *) fail EKS_CLUSTER_NOT_ACTIVE "EKS cluster is not active" "EKS cluster '$cluster' is $status, not ACTIVE." "Wait until the cluster is ACTIVE, then rerun the workflow." ;;
esac
[[ "$auth_mode" != "CONFIG_MAP" ]] ||
  fail EKS_ACCESS_ENTRIES_DISABLED "EKS access entries are off" "EKS cluster '$cluster' uses CONFIG_MAP authentication, but Radius setup grants access with access entries." \
    "Change the cluster's authentication mode to API_AND_CONFIG_MAP or API, then rerun environment setup."
ca_data=$(jq -r '.cluster.certificateAuthority.data // empty' "$work/cluster.json" | tr -d '\r\n')
printf '%s' "$ca_data" | base64 -d >"$work/ca.pem" 2>/dev/null && [[ -s "$work/ca.pem" ]] ||
  fail EKS_CLUSTER_NOT_ACTIVE "EKS cluster is not active" "EKS cluster '$cluster' returned no certificate authority." "Wait until the cluster is ACTIVE, then rerun the workflow."
[[ "$endpoint" == https://* ]] ||
  fail EKS_CLUSTER_NOT_ACTIVE "EKS cluster is not active" "EKS cluster '$cluster' returned no API server endpoint." "Wait until the cluster is ACTIVE, then rerun the workflow."
finish passed

# 3. Subnets the recipes place databases and caches in. Deploy and verify pass
# them; the delete workflows do not.
SUBNET_FIX="Rerun environment setup to choose subnets from the cluster's VPC."
if [[ -z "$subnets" ]]; then
  check_state[2]=skipped
else
  begin 2
  vpc=$(jq -r '.cluster.resourcesVpcConfig.vpcId' "$work/cluster.json")
  IFS=, read -ra subnet_list <<<"$subnets"
  if ! aws_ro ec2 describe-subnets --region "$region" --subnet-ids "${subnet_list[@]}" \
    --output json >"$work/subnets.json" 2>"$work/err"; then
    if grep -q InvalidSubnetID "$work/err"; then
      fail AWS_SUBNET_INVALID "Subnet not found" "RADIUS_SUBNET_IDS names a subnet that does not exist in $region: $(err_text)" "$SUBNET_FIX"
    elif grep -qE 'AccessDenied|UnauthorizedOperation|not authorized' "$work/err"; then
      fail AWS_PERMISSION_DENIED "AWS permission denied" "The deploy role cannot call ec2:DescribeSubnets in $region: $(err_text)" \
        "Rerun environment setup to restore the deploy role's permissions."
    fi
    fail AWS_API_UNREACHABLE "AWS API unreachable" "ec2:DescribeSubnets failed: $(err_text)" \
      "Rerun the workflow. If it fails again, check the AWS service health for $region."
  fi
  other=$(jq -r --arg v "$vpc" '[.Subnets[] | select(.VpcId != $v) | .SubnetId] | join(" and ")' "$work/subnets.json")
  [[ -z "$other" ]] ||
    fail AWS_SUBNET_INVALID "Subnet outside the cluster VPC" "Subnets $other are not in the VPC of EKS cluster '$cluster', so its pods could not reach resources placed there." "$SUBNET_FIX"
  azs=$(jq '[.Subnets[].AvailabilityZone] | unique | length' "$work/subnets.json")
  if ((azs < 2)); then
    warn AWS_SUBNET_SINGLE_AZ "Subnets in one Availability Zone" "RADIUS_SUBNET_IDS covers one Availability Zone. Amazon RDS needs subnets in at least two, so recipes that create RDS databases will fail."
  fi
  finish passed
fi

# 4. Reachability. First, is this runner's address in the public endpoint's
# allow list? The answer explains a connection failure. It does not decide
# one, because a runner on a connected network can still use the private
# endpoint.
begin 3
egress=$(curl -fsS --connect-timeout 5 --max-time 10 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]')
outside=""
if [[ "$public" == "true" && -n "$egress" ]] &&
  ! python3 - "$egress" "$work/cidrs" <<'PY'; then
import ipaddress, sys
ip = ipaddress.ip_address(sys.argv[1])
nets = [ipaddress.ip_network(l.strip()) for l in open(sys.argv[2]) if l.strip()]
sys.exit(0 if any(ip in n for n in nets) else 1)
PY
  outside=1
fi

# A bounded TCP and TLS request. Any HTTP status, even 401, proves the runner
# reached the API server.
http=$(curl -sS --cacert "$work/ca.pem" --connect-timeout 5 --max-time 10 \
  -o /dev/null -w '%{http_code}' "$endpoint/version" 2>"$work/err")
if [[ -z "$http" || "$http" == "000" ]]; then
  if [[ -n "$outside" ]]; then
    count=$(wc -l <"$work/cidrs" | tr -d ' ')
    entries="entries"
    [[ "$count" == 1 ]] && entries="entry"
    fix="Run the workflow on a runner that the cluster allows, for example a self-hosted runner in the cluster's VPC. GitHub-hosted runners use thousands of address ranges, and publicAccessCidrs holds at most 40."
    [[ "$private" == "true" ]] && fix="$fix This cluster also has a private endpoint, which a runner on a connected network can use."
    fail EKS_ENDPOINT_NOT_ALLOWED "Runner blocked by the EKS endpoint allow list" \
      "The runner could not connect to the API server of '$cluster'. Its address $egress is not in the cluster's public endpoint allow list (publicAccessCidrs, $count $entries)." "$fix"
  elif [[ "$public" != "true" ]]; then
    fail EKS_ENDPOINT_UNREACHABLE "EKS API server unreachable" \
      "The runner could not connect to the API server of '$cluster'. The cluster's public endpoint is off." \
      "Run the workflow on a runner inside the cluster's VPC or on a network connected to it."
  fi
  fail EKS_ENDPOINT_UNREACHABLE "EKS API server unreachable" \
    "The runner could not connect to the API server of '$cluster' within 10 s: $(err_text)" \
    "Check the cluster's endpoint access settings and security groups, then rerun the workflow."
fi
if [[ -n "$outside" ]]; then
  annotate notice EKS_ENDPOINT_PRIVATE_PATH "Runner reached EKS from outside the allow list" \
    "This runner's address $egress is outside publicAccessCidrs, but the runner still reached the API server. It may have used the private endpoint, or the address check saw a different address than the cluster did."
fi
finish passed

# 5. Authentication. The token stays in a file that is deleted on exit; it is
# never printed.
begin 4
if ! aws_ro eks get-token --region "$region" --cluster-name "$cluster" \
  --output json >"$work/token.json" 2>"$work/err"; then
  fail AWS_PERMISSION_DENIED "AWS permission denied" "Could not get an EKS token: $(err_text)" \
    "Rerun environment setup to restore the deploy role's permissions."
fi
jq -r '.status.token' "$work/token.json" >"$work/token"
rm -f "$work/token.json"
cat >"$work/kubeconfig" <<EOF
apiVersion: v1
kind: Config
clusters:
- name: eks
  cluster:
    server: $endpoint
    certificate-authority: $work/ca.pem
users:
- name: eks
  user:
    tokenFile: $work/token
contexts:
- name: eks
  context: {cluster: eks, user: eks}
current-context: eks
EOF

kc() { kubectl --kubeconfig "$work/kubeconfig" --request-timeout=10s "$@"; }

if ! kc version -o json >/dev/null 2>"$work/err"; then
  if grep -qiE 'Unauthorized|provide credentials' "$work/err"; then
    fail EKS_UNAUTHORIZED "EKS rejected the deploy role" \
      "The API server of '$cluster' returned 401 Unauthorized for the deploy role's token. The usual cause is that the role has no EKS access entry on this cluster." \
      "Rerun environment setup to grant the role access."
  fi
  fail EKS_ENDPOINT_UNREACHABLE "EKS API server unreachable" "kubectl could not connect to '$cluster': $(err_text)" \
    "Check the cluster's endpoint access settings and security groups, then rerun the workflow."
fi
finish passed

# 6. The permissions the deploy needs on the target, from EKS access policies
# or RBAC: Radius namespaces and secrets,
# and the CRDs and Helm release that the routes Gateway step installs.
begin 5
missing=""
for check in \
  "create namespaces" \
  "create secrets --all-namespaces" \
  "create customresourcedefinitions.apiextensions.k8s.io" \
  "create clusterroles.rbac.authorization.k8s.io" \
  "create deployments.apps --all-namespaces"; do
  # shellcheck disable=SC2086 # each check is a list of kubectl arguments
  answer=$(kc auth can-i $check 2>"$work/err")
  case "$answer" in
    yes) ;;
    no*) missing="$missing; $check" ;;
    # No answer means the request failed, so do not report it as a denial.
    *)
      fail EKS_ENDPOINT_UNREACHABLE "EKS API server unreachable" \
        "kubectl could not connect to '$cluster' while checking permissions: $(err_text)" \
        "Check the cluster's endpoint access settings and security groups, then rerun the workflow."
      ;;
  esac
done
[[ -z "$missing" ]] ||
  fail EKS_RBAC_MISSING "Missing Kubernetes permissions" "Kubernetes on '$cluster' would refuse these requests from the deploy role with 403 Forbidden:${missing#;}." \
    "Rerun environment setup. It associates AmazonEKSClusterAdminPolicy with the role's access entry."
finish passed
