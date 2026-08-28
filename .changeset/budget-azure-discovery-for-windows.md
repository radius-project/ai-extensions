---
"radius": patch
---

Fix an empty Namespace picker on the Environment page on Windows, where the Azure CLI runs as an `az.cmd` shim through a fresh Python interpreter and a plain `az aks get-credentials` takes about 24 seconds. Every `az` discovery query now shares a single 45-second budget instead of the 20 seconds that killed the credential fetch outright, and a failed namespace lookup now names the step that failed and its limit rather than reporting only the spawned command line.
