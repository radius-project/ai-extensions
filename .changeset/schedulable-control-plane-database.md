---
"radius": patch
---

**Fixed:** Deploying and deleting from a private or internal repository no longer
times out while setting up the Radius control plane. The control-plane database
reserved two CPUs, which is every core a standard GitHub-hosted runner gets
outside a public repository, so it could never start and the run failed before
reaching your application. It now reserves a small share of the runner and can
still use more when cores are free.
