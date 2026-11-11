---
"radius": patch
---

**Fixed:** AWS deploy, delete, and credential verification workflows now check their inputs, EKS access, and GHCR push access before any cloud or Radius resource changes, and stop with coded errors that say how to fix each problem, instead of failing later inside Radius. An AWS deploy whose `RADIUS_DEPLOY_PARAMS` secret is not exactly one JSON object now stops, instead of writing an error and deploying without those parameters. Both AWS delete workflows now refuse to run without a valid role, account, Region, and EKS cluster, so they no longer report success after deleting from the runner's temporary cluster and leaving the application on EKS. AWS setup rejects an invalid EKS cluster name before it writes to GitHub or AWS, and retrying a failed AWS setup now runs credential verification again instead of reporting the earlier failed run.

AWS support is still behind `RADIUS_CANVAS_AWS`. Existing AWS environments get these checks once the updated workflows are committed to the repository.
