---
"radius": patch
---

**Fixed:** **Retry setup** after a failed credential check now runs the check again in a new GitHub Actions run, so a fix you made since the failure is verified. Before, Azure setups stopped with "The setup operation cannot be resumed with these inputs" and AWS setups stopped because the verify workflow on the default branch "does not match the exact content from this operation". **Continue setup** after a pause follows the verification run that setup already started.
