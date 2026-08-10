---
"radius": minor
---

Hand the release over to Changesets end to end, and split it into two channels. Every merge to `main` refreshes the rolling `edge` channel. A stable release is cut deliberately: a maintainer runs the **Release** workflow, Changesets opens a release pull request with the changelog and version bump, and merging it validates the exact source commit before tagging `radius@<version>`, creating the GitHub release, and publishing an immutable `releases/radius/v<version>` install branch and `radius/v<version>` artifact tag alongside the rolling `releases/latest` branch and `latest` tag. Every published bundle records signed build provenance, so an installed plugin can be verified with `gh attestation verify`.
