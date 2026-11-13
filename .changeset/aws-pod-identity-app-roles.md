---
"radius": patch
---

**Added:** AWS environment setup now lets the `aws-eks` containers Recipe give each app its own IAM role through EKS Pod Identity. Setup creates a permissions boundary for the environment, records it in `AWS_APP_BOUNDARY_ARN`, and adds a `radius-app-roles-<repoId>` inline policy to the deploy role. That policy lets deployments manage IAM roles only under `/radius/apps/<repoId>/`, only with one of the repository's boundaries, and pass them only to EKS Pod Identity. Setup stops when the cluster has no `eks-pod-identity-agent` add-on, unless EKS Auto Mode is on.

Deleting an environment deletes its boundary when no IAM role uses it, and removes the app-roles policy with the repository's last environment on the role. Rollback and **Retry deletion** keep the app-roles policy until the environment policy is gone. The pinned `aws-eks` recipe pack now requires `appPermissionsBoundaryArn`, so environments set up by an earlier build must be set up again.
