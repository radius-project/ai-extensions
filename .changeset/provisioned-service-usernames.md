---
"radius": patch
---

**Fixed:** Generated application definitions now give every consumer of a provisioned database or message broker the same username the service is created with, read from one place instead of repeated as a separate value. The default username is `myadmin` unless the application fixes a specific login in its code or checked-in configuration; a username set only in Compose, `.env`, Helm, or Kubernetes manifests is not treated as a requirement.
