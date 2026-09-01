---
"radius": minor
---

Offer a **force delete** when a deployment delete has failed because the resource is stuck in a non-terminal provisioning state. The canvas reads the failed run's result artifact and, only when it proves the `409 … in progress state` conflict, asks — through the same lightweight confirmation the rest of the product uses — whether to force the delete anyway, warning that forcing may leave orphaned external resources. Confirming reruns the workflow as `rad app delete --preview --force`, and the completion message reminds you to check your cloud provider for resources that need manual cleanup. Deployment deletes now also link the workflow run they dispatched, both while the delete runs and once it finishes.
