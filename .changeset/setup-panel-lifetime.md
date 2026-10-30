---
"radius": patch
---

**Fixed:** Keep environment setup running when its panel closes, reuse the same operation when it reopens, and stop local verification and further setup work safely when the session shuts down without claiming to cancel remote work.

Session shutdown also stops cleanup between deletions and configuration between individual variable writes. Writes already in flight retain their account until their acknowledged results are recorded; interrupted cleanup and verification discovery remain resumable instead of reporting completion.

Shutdown during recovery-record persistence prevents unsent Azure, GitHub environment, branch and workflow writes. Radius records that those requests were not applied and does not start failure cleanup.

Shutdown before rereading an unresolved request preserves its original evidence and reconciliation-attempt count instead of consuming retries or escalating to manual recovery.

Shutdown after a lost write response or while a provider read fails also preserves unresolved evidence without consuming recovery attempts. GHCR bootstrap stops before the next HTTP request, upload step or retry, while responses already issued retain their actual outcome.

Azure owner and provenance-tag propagation retries stop issuing writes and reads after shutdown, including when shutdown interrupts a read delay. Incomplete or failed late reads preserve unresolved evidence instead of triggering failure cleanup or manual recovery; positive responses already in flight can still confirm the request. Rejected attempts retain their diagnostics, while user Stop still completes the current logical mutation.

Service-principal, GitHub environment and workflow recovery also stop nested retries, commit-history pages and branch-absence reads after shutdown. Incomplete evidence stays unresolved rather than claiming absence or requiring manual recovery. Complete proof from a request already in flight can still settle; matching workflow content alone cannot authorize another history read.

Verification dispatch and automatic run discovery stop further reads and monitoring after shutdown, without turning a late response into a setup failure. Sent requests retain their actual outcome; uncertain dispatches require inspection before another run can be sent, including after restart. Storage failures remain explicit.
