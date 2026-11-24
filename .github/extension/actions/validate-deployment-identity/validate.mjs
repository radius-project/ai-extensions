import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { verifyApprovedDeployment } from "./approved-deployment.mjs";
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
  await verifyApprovedDeployment(process.env, async (path) => {
    if (!process.env.GH_TOKEN)
      throw new Error(
        "Deployment records are unavailable. No cloud work was started."
      );
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${process.env.GH_TOKEN}`,
        accept: "application/vnd.github+json"
      },
      redirect: "error",
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok)
      throw new Error(
        "Could not read deployment records. No cloud work was started."
      );
    return response.json();
  });
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
