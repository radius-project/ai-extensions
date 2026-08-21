---
"radius": patch
---

Add a distinct **Abandon failed deployment** action that stops tracking a failed deployment in Radius Canvas and GitHub without authenticating to a cloud provider or claiming that cloud resources were deleted. The action is available only for failed deployments, warns that resources created before the failure may remain, and leaves the normal cloud teardown flow unchanged.
