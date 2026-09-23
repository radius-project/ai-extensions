---
"radius": minor
---

**Changed:** Deployments now use the latest released Radius resource types and recipe packs. The Azure and Kubernetes recipe packs define only recipes, so the deploy workflow creates the Radius environment on its own and then attaches the pack to it. Existing environments keep their recipe packs and no action is required.
