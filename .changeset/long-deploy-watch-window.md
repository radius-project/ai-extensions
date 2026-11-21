---
"radius": patch
---

**Fixed:** The canvas now keeps watching a deploy for 60 minutes instead of about 20, so a slow deploy, such as one creating several RDS databases, reports its real outcome instead of timing out while the workflow is still running. After the first 5 minutes it checks the workflow every 15 seconds instead of every 5, which uses fewer GitHub API requests.
