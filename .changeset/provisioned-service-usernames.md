---
"radius": patch
---

**Fixed:** Generated application definitions now give every consumer of a provisioned database or message broker the same username the service is created with, read from one place instead of repeated as a separate value. The username is `myadmin` unless the application's code or checked-in configuration fixes a login; a username the application reads from an environment variable is not treated as fixed, even when Compose, Helm, or Kubernetes manifests set it.
