---
"radius": minor
---

**Added:** AWS environment setup creates a permissions boundary for the environment's app roles and records `AWS_APP_ROLE_PATH` and `AWS_APP_BOUNDARY_ARN`. The deploy workflow passes them to the `aws-eks` recipe pack, so a container that sets `awsIamPolicy` gets its own IAM role through EKS Pod Identity. Setup warns when the cluster lacks the EKS Pod Identity Agent add-on, and environment deletion deletes the IAM roles under the environment's app role path, then the boundary. Environments set up earlier keep working without app roles until setup runs again.
