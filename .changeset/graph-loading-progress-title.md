---
"radius": patch
---

**Fixed:** Say "Loading the application graph" while the Graph tab reads an existing `.radius/app.bicep`, instead of "Generating application graph", which implied the model was being written. The progress panel switches to "Generating the application graph" only once Copilot actually starts authoring a model.
