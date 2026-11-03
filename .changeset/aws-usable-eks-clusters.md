---
"radius": patch
---

**Fixed:** The AWS environment form now offers only EKS clusters that Radius can use and says why each other cluster can't be used. The VPC comes from the selected cluster, and Create Environment stays disabled until the selected subnets cover two standard availability zones. Refresh keeps the selected cluster, namespace, and subnets when they're still available. The namespace list follows the selected cluster, and a note says when it shows common names because the cluster's namespaces can't be read.
