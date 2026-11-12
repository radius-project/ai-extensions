#!/bin/bash
# Sourced by run-rad-commands and validate-aws-inputs so both check commands
# against one list.
#
# Each command's leading verb must be in this list, so commands that do not fit
# the ephemeral, per-run model (managing or upgrading a control plane, switching
# workspaces, or changing install state) cannot run.
# shellcheck disable=SC2034 # used by the sourcing script
ALLOWED_VERBS="deploy app resource env recipe group credential resource-type version bicep"

is_allowed() {
  local verb="${1%% *}"
  case " $ALLOWED_VERBS " in *" $verb "*) return 0 ;; *) return 1 ;; esac
}
