---
"radius": patch
---

Host the Repo Radius workflow assets in this repository.

The verify, deploy, and delete GitHub Actions workflow templates and their
shared composite actions and scripts now live in `radius-project/ai-extensions`
under `.github/extension/`, ported from `radius-project/radius`. The extension
fetches the templates from `radius-project/ai-extensions@main` at commit time and
the committed provider workflows reference the composite actions in place from
`radius-project/ai-extensions`, so this repository is now the single source of
truth for the workflow contract. Fetching the `rad` CLI release binary and the
`install.sh` bootstrap still points at `radius-project/radius`, which remains the
home of the Radius product.

The shared `load-contrib-catalog` action fetches the Radius resource-type and
recipe-pack catalog (`deploy/manifest/defaults.yaml`) from `radius-project/radius`
by ref at runtime and installs `yq` from a co-located script, so the composite
actions are self-contained in this repository while the catalog data stays a
Radius-owned artifact validated by Radius CI.
