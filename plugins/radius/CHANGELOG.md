# radius

## 0.1.0

### Minor Changes

- Explore Radius applications across modeled, planned, deployed, and branch-diff views, with resolved cloud resources, per-resource deployment status and logs, and links to local or remote source definitions.
- Generate validated `.radius/app.bicep` application definitions from repository source with source references, deployment-aware container settings, and secret-connection guidance that matches the managed Radius version. Radius publishes the complete `.radius/` model atomically, so an unsuccessful run leaves existing files unchanged.
- Delete application deployments and Azure environments through tracked, confirmed workflows that preserve shared or manually changed resources. Radius requires application deployments to be removed before environment cleanup, cleans up owned resources in dependency order, manages Gateway API prerequisites for route deployments, removes only unused Radius-owned gateway infrastructure, and offers guarded force-delete recovery when an application resource is stuck in progress, with a warning that cloud resources may require manual cleanup.
- Create and verify deploy environments in a guided, resumable workflow that keeps the selected cloud and GitHub identities visible, validates credentials, and offers retry, continue, and rollback controls with redacted diagnostics. Azure setup supports immutable or customized GitHub OIDC subjects, Entra Service Management Reference policies, Enterprise Managed User accounts, service-principal sign-in, and AKS Azure RBAC, and prevents environments on the same cluster from sharing a Kubernetes namespace.
- Resolve setup and deployment problems from Radius Canvas through validated **Copy** and **Run with Copilot** command actions. Commands target the selected identity or branch, work across supported shells, require confirmation for state-changing operations, and return control for verification or retry.
