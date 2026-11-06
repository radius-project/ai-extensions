---
"radius": patch
---

**Fixed:** Pausing an environment setup that the extension restarted before it committed the deploy workflows now offers **Delete setup** and **Exit setup**. Before, Radius treated the verification workflow as unknown even though none could have run, so **Abandon setup** was the only way out.
