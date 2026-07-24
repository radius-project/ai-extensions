---
"@radius-project/canvas": patch
---

Fix the Deploy button being stuck greyed out after a failed deployment. Deploy
status is now derived from the deploy workflow run's completion rather than the
GitHub deployment-status record, which often stays `pending`/`in_progress` when a
run fails (the workflow never posts a terminal `failure` status) — so a failed
deploy was mis-reported as pending and kept the button disabled. A completed run
now resolves to `success` or `failed` by its conclusion, falling back to the
deployment record only when there is no linked run.

The Deploy button is also now greyed out **only while an operation is in
progress** (a deploy run still running, or a delete in flight). Terminal states no
longer block: a failed deploy can be retried and a successful deployment can be
redeployed over without deleting it first.
