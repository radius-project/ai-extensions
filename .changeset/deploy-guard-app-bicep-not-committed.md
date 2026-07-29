---
"@radius-project/canvas": patch
---

Fast-fail the deploy with actionable guidance when the target branch is pushed but has no `.radius/app.bicep` committed on that ref. Previously the workflow ran and produced a cryptic `curl: (23) Failure writing output to destination` when the recipe-pack download step tried to write into a `.radius/` directory that doesn't exist in the checkout. Now the extension checks for the bicep at dispatch time and shows a "Radius application not committed" dialog with a copy-ready `git add … && git commit … && git push` command, matching the existing "Branch not pushed" flow.
