---
"radius": patch
---

**Changed:** Remove the transitional Azure recipe-pack compatibility shim now that the Radius defaults catalog points at the pack-only recipe pack. The Azure deploy workflow no longer probes the downloaded pack for the legacy `environmentName`, `environmentNamespace`, `azureSubscriptionId`, and `azureResourceGroup` parameters, and passes only the parameters the pack-only artifact owns. Update the Radius plugin, then regenerate and recommit existing pinned `run-rad-commands-azure.yml` workflows.
