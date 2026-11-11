---
"radius": patch
---

**Fixed:** An AWS environment deletion that the extension stopped part way now takes back its own deploy role lock when you click **Retry deletion**, instead of waiting on it and asking you to remove it. A **Delete setup** that the extension stopped part way also keeps every removal AWS already confirmed, so it no longer lists those resources as still there.
