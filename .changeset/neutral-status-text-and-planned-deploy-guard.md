---
"radius": patch
---

Make resource status read as information rather than alarm, and stop the Planned tab from offering a deploy that the server will reject:

- The Environments, Credential profiles, and Deployments tables now show their status as plain text. The colored circle that preceded each label added no information the label did not already carry, and a wall of red and amber dots made every table look like it needed attention. Every status value and its fallback are unchanged, as is the status-driven behavior such as disabled deployment deletion.
- "Delete Deployment" on a failed deployment now uses the same neutral outline as every other row, turning solid red only on hover. A failed deployment previously rendered the destructive action pre-armed in solid red, which made the most alarming row in the table the easiest one to click by accident. Failed and successful rows stay enabled; pending, deleting, and optimistic rows stay disabled.
- The Planned tab's "Deploy Application" button is now disabled while a deployment of the same application and environment is already pending, in progress, or deleting, matching the Deployments tab. The button previously stayed enabled, so the click was accepted by the page and then refused at the server as a conflicting operation. The button's title and the hint beneath it name the application and environment that are busy and point at the Deployments tab. Matching is on the exact application and environment pair, so an unrelated deployment does not block it, and the guard fails closed: if the deployment listing cannot be read, deploying is disabled rather than allowed.

The deployment listing parser, the application-and-environment key, and the rule for which statuses block a mutation now live in one place shared by both tabs, so the two views cannot drift apart.
