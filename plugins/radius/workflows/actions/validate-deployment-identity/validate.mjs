import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  commandsMatchWorkflowApplication,
  literalWorkflowApplication
} from "../../../../packages/core/src/workflow-application-identity.ts";

const application = process.env.DECLARED_APPLICATION || "unknown";
if (process.env.IDENTITY_KIND === "delete") {
  if (!/^[a-zA-Z][a-zA-Z0-9-]{0,62}$/.test(application))
    throw new Error(
      "The delete target is not a supported literal application name. No cloud work was started."
    );
} else if (application !== "unknown") {
  const workspace = resolve(process.env.GITHUB_WORKSPACE || ".");
  const appFile = process.env.MODEL_FILE || "";
  const model = resolve(workspace, appFile);
  if (!model.startsWith(workspace + sep))
    throw new Error(
      "The declared model must be inside the checked-out repository."
    );
  if (literalWorkflowApplication(readFileSync(model, "utf8")) !== application)
    throw new Error(
      "The checked-out model does not match the declared literal application. No cloud work was started."
    );
  if (
    !commandsMatchWorkflowApplication(
      process.env.RAD_COMMANDS || "",
      appFile,
      process.env.TARGET_ENVIRONMENT || "",
      application
    )
  )
    throw new Error(
      "The command override is incompatible with the declared application. Use unknown identity for arbitrary commands. No cloud work was started."
    );
}
