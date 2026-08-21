---
"radius": patch
---

Harden the environment-deletion flow in response to review feedback:

- Detect an environment's provider from the exact canonical variable name
  (`AZURE_CLIENT_ID` / `AWS_EKS_CLUSTER_NAME`) instead of a substring regex over
  every variable name joined together, so a user-defined `MY_AZURE_THING` can no
  longer misclassify an AWS environment as Azure.
- Route environment-controlled `vars.*` (client id, resource group, cluster,
  subscription) through `env:` in the bundled delete workflows rather than
  interpolating them into shell source, closing a command-injection path in a job
  holding `id-token: write`.
- Cap the Azure delete job with `timeout-minutes: 30` so a wedged run cannot keep
  running for hours and land `rad env delete` underneath a user's retry.
- Emit the guard step's `app_names` output through a delimited heredoc so an
  application name containing a newline cannot corrupt `$GITHUB_OUTPUT` and make
  the guard read an empty application count.
- Spell out the full blast radius (cluster teardown and the possibly-shared app
  registration credential) in the delete confirmation dialog.
- Sort audience arrays once when comparing credential provenance instead of
  re-sorting inside the comparison loop.
