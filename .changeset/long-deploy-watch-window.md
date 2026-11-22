---
"radius": patch
---

**Fixed:** The canvas now keeps watching a deploy for 60 minutes instead of about 20, so a slow deploy, such as one creating several RDS databases, reports its real outcome instead of timing out while the workflow is still running. Long deploys and app deletes also use far fewer GitHub API requests: the Deployments page no longer starts a new deployment lookup every few seconds, and the canvas checks the workflow every 15 seconds after the first 5 minutes. An app delete is now followed for up to 30 minutes instead of 3, and a failed delete is reported instead of leaving the row deleting.
