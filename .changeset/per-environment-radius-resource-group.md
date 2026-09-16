---
"radius": patch
---

**Fixed:** Each deploy environment now gets its own Radius resource group, so two environments backed by the same cloud scope no longer provision the same cloud resources. A Recipe derives the cloud resource it provisions from a Radius resource ID that contains the resource group but carries no environment identity, so a shared group made an application deployed to two environments resolve to one shared server: one environment silently adopted the other's data, and deleting either destroyed it.
