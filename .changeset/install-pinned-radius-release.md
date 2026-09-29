---
"radius": patch
---

**Fixed:** Deploy and delete workflows now install the Radius CLI and control plane from the pinned stable Radius release instead of the latest unreleased `edge` build, so an unreleased Radius change can no longer break or change deployments. The workflow fails early if the installed CLI or control plane is not that release.
