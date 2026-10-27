---
"radius": patch
---

**Fixed:** Keep the correct environment verification status when more than 100 newer workflow runs exist. Look up only runs linked to the environment's recent deployments instead of reading the full repository history.

For a GitHub App that cannot write workflow files, show how to grant the missing Workflows permission and renew the installation token instead of suggesting an OAuth scope refresh.
