---
"radius": patch
---

**Fixed:** Allow environment setup to use a GitHub App installation token with the required repository permissions while using a separate credential for GitHub Packages. Generated workflows can use `RADIUS_GHCR_TOKEN` and `RADIUS_GHCR_USERNAME` when a PAT-published state package is not accessible to the repository's `GITHUB_TOKEN`, and setup and deletion verify the immutable bootstrap manifest when GHCR omits the canonical repository link.
