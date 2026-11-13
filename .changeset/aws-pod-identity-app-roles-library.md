---
"@radius-project/core": patch
"@radius-project/graph-react": patch
---

**Added:** Build the EKS Pod Identity permissions boundary and the per-repository `radius-app-roles-<repoId>` inline policy for AWS deploy roles, and pass `appPermissionsBoundaryArn` to the `aws-eks` recipe pack. The app-roles policy shares the deploy role's 10,240-character inline policy limit, so a role now holds about 15 environments instead of 17. The graph ranks an EKS container's Pod Identity association below its Deployment, as it already ranks the IAM role.
