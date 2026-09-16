---
"radius": patch
---

**Fixed:** Allow environment setup to use a GitHub App installation token with the required repository permissions while using a separate credential for GitHub Packages. State package setup and deletion now verify the immutable bootstrap manifest when GHCR omits the canonical repository link for a PAT-published package.
