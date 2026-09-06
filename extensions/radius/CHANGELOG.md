# radius

## 0.1.1

### Patch Changes

- [#712](https://github.com/radius-project/ai-extensions/pull/712) [`da03f88`](https://github.com/radius-project/ai-extensions/commit/da03f884e0a44cbcae38fe350ecf8ced78a21208) Thanks [@willdavsmith](https://github.com/willdavsmith)! - **Fixed:** Preserve developer-configured Radius CLI builds when application modeling cannot derive a compatible extension reference.

- [#737](https://github.com/radius-project/ai-extensions/pull/737) [`5712652`](https://github.com/radius-project/ai-extensions/commit/57126527220638d2fc26c8047560d9b79019a4a6) Thanks [@willdavsmith](https://github.com/willdavsmith)! - **Fixed:** Reject invalid Kubernetes namespace names during environment creation instead of allowing deployment to fail later.

- [#730](https://github.com/radius-project/ai-extensions/pull/730) [`f9d6c1b`](https://github.com/radius-project/ai-extensions/commit/f9d6c1bb8f5bb58caaa2b8750f47250570a7d535) Thanks [@kachawla](https://github.com/kachawla)! - **Fixed:** Generated `app.bicep` no longer breaks a backing service whose schema takes a credential as a secret reference. Two defects are corrected. First, two resource types can name a property `password` with opposite meanings — `Radius.Data/mySqlDatabases.password` is the sensitive value itself, while `Radius.Messaging/rabbitMQ.password` is the resource ID of a `Radius.Security/secrets` resource — and the previous guidance chose by property name, so a RabbitMQ app was modeled with the password where the Secret's resource ID belongs and the deployment failed Kubernetes validation. Second, an authored Secret could expose the credential under a renamed key such as `PASSWORD`, so the broker resolved the right Secret but never found the lowercase `password` key its recipe requires and the container failed to start. The application modeling guidance now decides from the schema's `x-radius-sensitive` flag instead of the property's name, requires the authored Secret to use the exact case-sensitive data key the consuming schema names, and ships a worked RabbitMQ example alongside the MySQL one.

- [#731](https://github.com/radius-project/ai-extensions/pull/731) [`c4aaf0f`](https://github.com/radius-project/ai-extensions/commit/c4aaf0f81c4c31518dc0109bed10f9193262a7c2) Thanks [@kachawla](https://github.com/kachawla)! - **Fixed:** The application model checker now rejects a `@secure()` parameter assigned to a resource property that the type's schema does not mark sensitive, so a credential can no longer be written where a `Radius.Security/secrets` resource ID belongs. Type resolution records each resolved property's sensitivity for the checker, which lets it separate `Radius.Data/mySqlDatabases.password`, where the secure parameter belongs inline, from `Radius.Messaging/rabbitMQ.password`, where it produces a deployment that Kubernetes rejects. Resolve every predefined type the model uses so the check has the schema evidence it needs.

- [#594](https://github.com/radius-project/ai-extensions/pull/594) [`1654059`](https://github.com/radius-project/ai-extensions/commit/1654059b7886f769116465541953d1b58ececabc) Thanks [@Reshrahim](https://github.com/Reshrahim)! - Update the plugin installation instructions to use the GitHub Copilot app's searchable plugin catalog.

## 0.1.0

- Explore Radius applications across modeled, planned, deployed, and branch-diff views, with resolved cloud resources, per-resource deployment status and logs, and links to local or remote source definitions.

- Generate validated `.radius/app.bicep` application definitions from repository source with source references, deployment-aware container settings, and secret-connection guidance that matches the managed Radius version. Radius publishes the complete `.radius/` model atomically, so an unsuccessful run leaves existing files unchanged.

- Delete application deployments and Azure environments through tracked, confirmed workflows that preserve shared or manually changed resources. Radius requires application deployments to be removed before environment cleanup, cleans up owned resources in dependency order, manages Gateway API prerequisites for route deployments, removes only unused Radius-owned gateway infrastructure, and offers guarded force-delete recovery when an application resource is stuck in progress, with a warning that cloud resources may require manual cleanup.

- Create and verify deploy environments in a guided, resumable workflow that keeps the selected cloud and GitHub identities visible, validates credentials, and offers retry, continue, and rollback controls with redacted diagnostics. Azure setup supports immutable or customized GitHub OIDC subjects, Entra Service Management Reference policies, Enterprise Managed User accounts, service-principal sign-in, and AKS Azure RBAC, and prevents environments on the same cluster from sharing a Kubernetes namespace.

- Resolve setup and deployment problems from Radius Canvas through validated **Copy** and **Run with Copilot** command actions. Commands target the selected identity or branch, work across supported shells, require confirmation for state-changing operations, and return control for verification or retry.
