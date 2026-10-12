---
"radius": patch
---

**Fixed:** Azure environment setup now retries temporary Microsoft Entra errors when it creates the service principal. It shows Entra's real error instead of a general message, and it removes the GitHub environment that a failed setup created. If Radius cannot tell whether the service principal was created, it checks the directory before it retries or removes anything.
