---
"radius": patch
---

**Added:** AWS environment setup now lets the `aws-eks` containers Recipe give each app its own IAM role through EKS Pod Identity. Setup creates a permissions boundary for the environment, records it in `AWS_APP_BOUNDARY_ARN`, and adds a `radius-app-roles-<repoId>` inline policy to the deploy role. That policy lets deployments manage IAM roles only under `/radius/apps/<repoId>/`, only with one of the repository's boundaries, and pass them only to EKS Pod Identity. Setup stops when the cluster has no `eks-pod-identity-agent` add-on, unless EKS Auto Mode is on.

Environments set up by an earlier build must be set up again, because the pinned `aws-eks` recipe pack now requires `appPermissionsBoundaryArn`.
