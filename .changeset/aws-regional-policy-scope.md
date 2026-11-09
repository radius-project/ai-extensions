---
"@radius-project/core": patch
---

**Fixed:** Hash repository and environment identities into AWS inline policy names and persist the exact name for cleanup. Restrict service-linked-role creation to supported recipe services, omit service-linked-role deletion, and exclude EKS access administration from regional grants. Compact policies support about 17 environments per role without other inline grants; `account:GetPrimaryEmail` is no longer included.
