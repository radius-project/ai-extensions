---
"@radius-project/canvas": patch
---

Add the `radius-delete` skill for deleting a Radius application or environment
via the auto-generated GitHub Actions workflow. It documents dispatching the
`delete-application.yml` / `delete-environment.yml` workflows, how the delete
restores and re-persists the OCI-backed state archive around `rad app delete` /
`rad env delete`, and common failure modes (GHCR/state-archive auth and the
in-progress-state 409 on a stranded resource). The delete workflow templates
remain canonical in `radius-project/radius`.
