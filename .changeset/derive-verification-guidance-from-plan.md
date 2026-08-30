---
"@radius-project/adapter-canvas": patch
---

Derive the pull-request guidance shown during environment creation from the
verification outcome instead of predicting it. When Radius lacked push access
and committed the setup workflows to a branch, the progress log told the
customer that credential verification and deploys would run once the pull
request landed on the default branch. That sentence was written at
pull-request time, before `planCredentialVerification`, the cloud-credential
check, and the dispatch had decided anything, so a repository that already
carried the verify workflow on its default branch was told verification was
waiting for a merge in the same run that dispatched it against the setup
branch, and a repository with incomplete cloud credentials was told to merge
when merging was not what unblocked it. The guidance is now emitted once, after
every one of those steps has run, and distinguishes the three real outcomes:
verification already running (an observation, since the merge is not what it
waits on), verification waiting for the merge, and verification waiting on the
cloud credentials rather than the merge. A run whose dispatch is rejected fails
before the guidance, so it no longer claims verification started.
