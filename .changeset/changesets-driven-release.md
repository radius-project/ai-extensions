---
"radius": minor
---

Use Changesets for stable version selection, changelogs, and release pull requests, and split delivery into two channels. Every merge to `main` refreshes the rolling `radius@edge` channel. Merging a deliberate release PR validates the exact source commit, creates a scoped Changesets-format `radius@<version>` tag, publishes zero-history versioned install refs plus the rolling `radius@latest` channel, and drafts the GitHub release until its deterministic tarball, native pnpm SPDX SBOM, and awesome-copilot listing are attached. Published artifacts carry signed provenance and standard SBOM attestations.
