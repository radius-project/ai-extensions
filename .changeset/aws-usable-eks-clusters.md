---
"radius": patch
---

**Fixed:** The AWS environment form now offers only EKS clusters that Radius can use and says why each other cluster can't be used. The VPC comes from the selected cluster, and Create Environment stays disabled until the selected subnets cover two standard availability zones. Refresh keeps the selected cluster, namespace, and subnets when they're still available. The namespace list follows the selected cluster, and Create Environment stays disabled while the list loads. If the cluster's namespaces can't be read, the list shows only `default`, and a note says why. Setup waits for an `UPDATING` cluster to be `ACTIVE` before it changes anything.
