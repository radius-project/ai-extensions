---
"@radius-project/adapter-canvas": patch
---

Let a failed credential verification be undone. Successful verification is now the point where an environment counts as finished, so until it passes, a setup that committed its workflow files still offers a way out: a failed verification — including an OIDC or Azure Login failure — shows **Retry verification** and **Roll back environment setup** side by side, and a setup that is waiting on its pull request offers the same rollback.

**Roll back environment setup** starts in your repository, because that is where the risk is. Radius saved the branch, commit, blob, and content digest of every workflow file it wrote, and it checks all of them before touching anything: a file that changed since Radius committed it, a setup branch whose head has moved, a file it cannot read, or a record too old to prove what it wrote all stop the rollback before a single resource is removed, and the panel names what to review by hand. When everything checks out, Radius reverts the workflow files through a new commit — restoring the version it replaced, or deleting the file it created — or closes and deletes an unmerged setup branch and its pull request, and only then removes the GitHub environment and the cloud identity behind them, in reverse dependency order. The confirmation lists every file and resource before you agree to it.

An environment whose verification succeeded is finished work and is no longer rolled back through its setup record; remove it with **Delete Environment** as before. Reused resources, resources Radius cannot prove it created, and workflow files that are no longer its own are never removed, and deploying your application stays a separate action you start yourself.
