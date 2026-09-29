---
"radius": patch
---

**Changed:** Remove the transitional Azure recipe-pack compatibility shim now that the Radius defaults catalog points at the pack-only recipe pack. The Azure deploy workflow no longer probes the downloaded pack for the legacy `environmentName`, `environmentNamespace`, `azureSubscriptionId`, and `azureResourceGroup` parameters, and passes only the parameters the pack-only artifact owns. Workflows already committed to a repository keep deploying unchanged and do not need to be regenerated: each loads the catalog its own pinned ref names, and the shim they still carry passes a legacy parameter only while the pack it downloads declares one.
