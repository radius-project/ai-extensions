---
"radius": patch
---

Fix the Planned tab answering an early selection with "Create an environment to preview the planned deployment for this application" when an environment already exists.

Environment availability was only recorded once the applications, branches, environments, *and* deployment listings had all resolved. The deployment listing is fetched with `fresh=1`, so it is the slowest of the four, and the selectors accept input long before it returns. A branch, application, or environment change made in that window was evaluated against `hasEnv: false`, which replaced the planned graph with the create-an-environment prompt instead of planning the deployment.

Environment availability is now settled as soon as the three selector listings resolve, so a selection made while deployment states are still loading plans normally. The Deploy Application button stays closed until the deployment listing arrives — it now reports "Deployment states are still loading" rather than being enabled against unknown state — so deployment safety is unchanged.
