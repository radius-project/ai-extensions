#!/bin/bash
# Prints a coded STATE_RESTORE_FAILED error when the caller set the action's
# coded-messages input to true, as the AWS templates do. Other callers keep
# their original output.
# Usage: state-restore-failed.sh <message> <fix>
set -uo pipefail
[[ "${CODED_MESSAGES:-}" == true ]] || exit 0
# shellcheck source=.github/extension/scripts/workflow-annotations.sh
source "$(dirname "${BASH_SOURCE[0]}")/../../scripts/workflow-annotations.sh"
annotate error STATE_RESTORE_FAILED "Radius state was not restored" "$1" "$2"
