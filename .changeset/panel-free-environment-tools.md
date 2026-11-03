---
"radius": minor
---

**Added:** Configure and verify Azure or AWS environments without opening Canvas using `radius_setup_environment`, inspect saved setup and verification with `radius_environment_status`, and resume or control that same operation with `radius_environment_control`. Setup never deploys; account choices and sensitive commands require trusted host interaction, and cleanup remains limited to proven-owned setup resources.

Cooperative Stop remains available while setup holds its GitHub account lease, credentials are unavailable or another tool interaction is pending. Concurrent Stop requests stay bound to the same target and account rather than being refused because an earlier Stop changed progress. Stop rechecks its original target and runtime immediately before recording the request, without an intervening asynchronous wait. Setup trims surrounding whitespace from environment names and returns the canonical target with its operation ID for subsequent status and control calls.

AWS remains behind the default-off startup developer switch. Supply account, region, cluster, VPC, subnet IDs and either `roleName` or `existingRoleArn`; an existing role takes precedence when both selectors are supplied. Disabled AWS setup does not ask for a GitHub account. Continue/Retry refuses a missing or invalid role selector instead of authorizing a default role. AWS setup requests are not retained across runtime restarts; start a new setup after restarting.

Input prompts refresh after setup finishes settling, and application-selection prompts include bounded, redacted choices with IDs, creation dates and the saved default. Verification reports the required setup pull request merge with a validated link to the saved repository's pull request when available. Runtime shutdown preserves uncertain verification dispatch evidence without starting further reconciliation or reporting a false terminal failure.

Resume keeps the original request's authority through answer reads and saves without requiring a panel. Controls report temporary task-busy guidance separately from failed durable correction. Verification bypass rechecks the saved target and runtime immediately before writing its marker, including after GitHub identity verification; already-issued writes retain their actual result.

An inconclusive GitHub Packages check reports unavailable access and asks you to retry the same account, rather than silently selecting another account or suggesting a scope grant. Confirmed push access remains valid if empty-upload cleanup fails. Workflow status observations that were saved successfully remain intact if authority is lost immediately afterward.

Runtime shutdown prevents new account-access probes and includes pending upload cleanup and account restoration in the existing bounded drain.
