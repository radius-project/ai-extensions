#!/bin/bash
# Sourced by the AWS workflow scripts so every coded failure has one format:
#   ::error title=<title>::[<CODE>] <what happened>. Fix: <one action>.
# A code is stable, so a reader or a tool can match it. The text after it can
# change.

# Workflow commands end at a newline, so untrusted text must be escaped or a
# value such as an AWS error message could start a new command.
annotation_escape_data() {
  local s=$1
  s=${s//'%'/%25}
  s=${s//$'\r'/%0D}
  s=${s//$'\n'/%0A}
  printf '%s' "$s"
}

annotation_escape_property() {
  local s
  s=$(annotation_escape_data "$1")
  s=${s//:/%3A}
  s=${s//,/%2C}
  printf '%s' "$s"
}

# annotate <error|warning|notice> <CODE> <title> <message> [fix]
annotate() {
  local level=$1 code=$2 title=$3 text=$4 fix=${5:-}
  [[ -z "$fix" ]] || text="$text Fix: $fix"
  printf '::%s title=%s::%s\n' "$level" "$(annotation_escape_property "$title")" "$(annotation_escape_data "[$code] $text")"
}
