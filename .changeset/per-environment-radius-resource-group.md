---
"radius": patch
---

**Fixed:** Each deploy environment now gets its own Radius resource group instead of sharing `default`, so two environments backed by the same cloud scope no longer provision the same cloud resources. A Recipe derives the cloud resource it provisions from a Radius resource ID that contains the resource group but carries no environment identity, so deploying every environment into `default` made an application deployed to two environments resolve to one shared server: one environment silently adopted the other's data, and deleting either destroyed it.

Environments that already have resources in `default` keep using it, because moving them would orphan them and provision empty replacements. To move an existing environment onto its own group, delete it and create it again.
