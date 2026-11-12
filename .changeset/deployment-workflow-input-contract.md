---
"radius": patch
---

**Fixed:** Refuse deployment before writing parameter secrets when installed workflows cannot accept the deployment model and correlation inputs. Install the current Radius release and regenerate the deployment workflows before retrying an incompatible workflow.

Deployments without an explicit model path continue to select `.radius/app.bicep` first, then `app.bicep` at the repository root. Explicit paths and repair attempts stay bound to the selected model rather than falling back to another file.
