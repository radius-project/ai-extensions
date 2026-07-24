---
"@radius-project/canvas": patch
---

Add the `radius-delete` skill for tearing down Radius deployments from the
canvas. It documents deleting an application deployment via the committed
`delete-application.yml` workflow (which runs `rad app delete` on an ephemeral
control plane and restores/re-persists the OCI-backed state archive around it),
and removing a GitHub deploy environment (guarded so it refuses while an app is
still deployed). It also covers common failure modes (GHCR/state-archive auth
and the in-progress-state 409 on a stranded resource). The delete workflow
templates are canonical in `radius-project/radius`.
