---
"radius": patch
---

Fix the Planned tab answering an early selection with "Create an environment to preview the planned deployment for this application" when an environment already exists.

Environment availability was only recorded once the applications, branches, environments, *and* deployment listings had all resolved. The deployment listing is fetched with `fresh=1`, so it is the slowest of the four, and the selectors accept input long before it returns. A branch, application, or environment change made in that window was evaluated against `hasEnv: false`, which replaced the planned graph with the create-an-environment prompt instead of planning the deployment.

Selections made while selector data is still loading are now held until application, branch, and environment availability are known, then planned normally. The Deploy Application button stays closed until the deployment listing arrives and explains that deployment states are still loading.
