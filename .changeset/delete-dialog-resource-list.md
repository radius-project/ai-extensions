---
"radius": patch
---

**Changed:** The delete confirmation for a deployed application now lists the resources the deletion will destroy, naming each one and its type before you type the confirmation phrase. Long deployments show the first several resources and a count of the rest, so the confirmation control stays in view. When Radius Canvas has no confirmed picture of what is deployed — nothing deployed yet, a graph that only shows the modeled application, or a graph that failed to load — the dialog keeps its existing wording instead of naming resources it cannot vouch for. Stopping tracking of a failed teardown is unchanged, because it deletes nothing.
