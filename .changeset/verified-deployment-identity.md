---
"radius": patch
---

**Fixed:** Use each deployment's workflow evidence to identify its application instead of the repository's current default model. Keep deployments with missing, expired or unreadable identity evidence visible, but block Delete, Force Delete and Abandon until their identity can be verified. Reject stale selections and preserve newer deployment state during deletion.
