---
"@radius-project/core": patch
"@radius-project/graph-react": patch
---

**Added:** Build the EKS Pod Identity permissions boundary and the `radius-app-roles-<repoId>` deploy-role policy, pass `appPermissionsBoundaryArn` to the `aws-eks` recipe pack, and rank an EKS container's Pod Identity association below its Deployment in the graph.
