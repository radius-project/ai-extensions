---
"radius": patch
---

Create only the ID-bound Azure federated credential when GitHub explicitly
reports an immutable default OIDC subject, while retaining dual credentials for
inconclusive rollout states. Warn when a legacy mutable credential remains.
