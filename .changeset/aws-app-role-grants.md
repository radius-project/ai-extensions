---
"@radius-project/core": minor
---

**Added:** Build the app identity, permissions boundary, and app role grants for AWS environments. The deploy role can create, update, and delete only roles under the environment's IAM path that carry its boundary, and pass them only to EKS Pod Identity. The grants make each environment's policy larger, so a shared deploy role now holds about 6 environments instead of 17.
