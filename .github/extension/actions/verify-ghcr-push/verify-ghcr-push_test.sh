#!/bin/bash
# Tests verify-ghcr-push.sh with a stub curl. No network.
# Run: bash .github/extension/actions/verify-ghcr-push/verify-ghcr-push_test.sh
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

# STUB_TOKEN and STUB_PROBE: an HTTP status, "fail" (curl cannot connect), or,
# for the token endpoint only, "notoken" (200 without a token).
cat >"$tmp/bin/curl" <<'EOF'
#!/bin/bash
out="" url=""
while (($#)); do
  case "$1" in
    -o) out=$2; shift 2 ;;
    -w | -u | -X | -H | --connect-timeout | --max-time) shift 2 ;;
    *) url=$1; shift ;;
  esac
done
echo "$url" >>"$STUB_LOG"
case "$url" in
  https://ghcr.io/token*) mode=$STUB_TOKEN ;;
  *) mode=$STUB_PROBE ;;
esac
if [[ "$mode" == fail ]]; then
  echo "curl: (28) Connection timed out after 5001 milliseconds" >&2
  exit 28
fi
if [[ "$mode" == notoken ]]; then
  echo '{"errors":[]}' >"$out"
  printf 200
  exit 0
fi
echo '{"token":"t0ken"}' >"$out"
printf '%s' "$mode"
EOF
chmod +x "$tmp/bin/curl"

pass=0 fail=0
ok() { echo "ok   $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); printf '%s\n' "$out"; }

# run <registry> <token mode> <probe mode>
run() {
  : >"$tmp/env"
  : >"$tmp/log"
  out=$(env PATH="$tmp/bin:$PATH" GITHUB_ENV="$tmp/env" STUB_LOG="$tmp/log" GH_ACTOR=octo GH_TOKEN=gh-secret \
    STATE_REGISTRY="$1" STUB_TOKEN="$2" STUB_PROBE="$3" \
    bash "$here/verify-ghcr-push.sh" 2>&1)
  status=$?
  recorded=$(sed -n 's/^GHCR_PUSH_CHECK=//p' "$tmp/env")
}

# expect <name> <registry> <token> <probe> <exit> <recorded> <code or ->
expect() {
  local name=$1 code=$7
  run "$2" "$3" "$4"
  if [[ "$status" -ne "$5" || "$recorded" != "$6" ]]; then bad "$name (exit $status, recorded '$recorded')"; return; fi
  if [[ "$code" == - ]]; then
    grep -q '^::error' <<<"$out" && { bad "$name (unexpected error)"; return; }
  else
    grep -q "^::error title=[^:]*::\[$code\] " <<<"$out" ||
      { bad "$name (no $code annotation)"; return; }
    # Canvas reads 401, 403, and Forbidden in this step as a permissions problem.
    if [[ "$code" != GHCR_PUSH_DENIED ]] && grep -qE '\b40[13]\b|Forbidden' <<<"$out"; then
      bad "$name (non-denial mentions a denial)"
      return
    fi
  fi
  ok "$name"
}

R=ghcr.io/octo/app-radius-state
expect "no registry is skipped" "" 200 202 0 skipped -
expect "registry outside ghcr.io is skipped" docker.io/octo/state 200 202 0 skipped -
expect "push allowed" "$R" 200 202 0 ok -
expect "token endpoint cannot connect" "$R" fail 202 1 "" GHCR_UNREACHABLE
expect "token endpoint 500" "$R" 500 202 1 "" GHCR_UNREACHABLE
expect "token endpoint returns no token" "$R" notoken 202 1 "" GHCR_UNREACHABLE
expect "token endpoint 403" "$R" 403 202 1 failed GHCR_PUSH_DENIED
expect "push denied" "$R" 200 403 1 failed GHCR_PUSH_DENIED
expect "push unauthorized" "$R" 200 401 1 failed GHCR_PUSH_DENIED
expect "probe cannot connect" "$R" 200 fail 1 "" GHCR_PROBE_FAILED
expect "probe 500" "$R" 200 500 1 "" GHCR_PROBE_FAILED

run "$R" 200 403
if grep -q 'HTTP 403 (Forbidden)' <<<"$out"; then ok "denial names the status"; else bad "denial names the status"; fi
run "$R" 200 401
if grep -q 'HTTP 401 (Unauthorized)' <<<"$out"; then ok "401 is called Unauthorized"; else bad "401 is called Unauthorized"; fi
run "$R" 200 202
if grep -q 'scope=repository:octo/app-radius-state:pull,push' "$tmp/log" && grep -qx 'https://ghcr.io/v2/octo/app-radius-state/blobs/uploads/' "$tmp/log"; then
  ok "asks for push on the state package"
else
  bad "asks for push on the state package"
fi
if grep -q gh-secret <<<"$out"; then bad "token is not printed"; else ok "token is not printed"; fi
if grep -q -- '--max-time' "$here/verify-ghcr-push.sh"; then ok "requests are time-limited"; else bad "requests are time-limited"; fi

echo "$pass passed, $fail failed"
((fail == 0))
