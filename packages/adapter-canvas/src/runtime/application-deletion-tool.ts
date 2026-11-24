import {
  deploymentRunId,
  type ApplicationDeletionRequest
} from "@radius-project/core";
import { isValidRepoSlug } from "@radius-project/core/platforms";
import type { PreparedApplicationDeletion } from "../server/services/selected-application-deletion.js";

export interface ApplicationDeletionToolPorts {
  confirm(message: string): Promise<boolean | undefined>;
  prepare(
    request: ApplicationDeletionRequest
  ): Promise<PreparedApplicationDeletion | undefined>;
  redact(message: string): string;
}

const parameters = {
  type: "object",
  properties: {
    repo: { type: "string" },
    environment: { type: "string" },
    application: { type: "string" },
    deploymentId: {
      type: "string",
      description: "GitHub deployment ID from the current Radius listing."
    },
    runUrl: {
      type: "string",
      description: "GitHub Actions run URL from that same deployment record."
    },
    mode: { type: "string", enum: ["normal", "force_retry"] }
  },
  required: [
    "repo",
    "environment",
    "application",
    "deploymentId",
    "runUrl",
    "mode"
  ],
  additionalProperties: false
} as const;

export const APPLICATION_DELETION_TOOL = {
  name: "radius_delete_application",
  description:
    "Dispatch deletion of an exact Radius application deployment in the current repository after trusted user confirmation. Force retry requires a separate confirmation and fresh proof of an eligible deletion conflict.",
  parameters
};

function cleanText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !/\p{C}/u.test(value)
  );
}

export function createApplicationDeletionTool(
  ports: ApplicationDeletionToolPorts
) {
  function interaction(code: string, message: string) {
    return { kind: "interaction_required", code, message } as const;
  }
  return {
    parameters,
    async handler(payload: unknown) {
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return interaction(
          "application-deletion-input-required",
          "Provide the repository, environment, application, deployment ID, run URL, and deletion mode."
        );
      const args: Record<string, unknown> = Object.fromEntries(
        Object.entries(payload)
      );
      const { repo, environment, application, deploymentId, runUrl, mode } =
        args;
      if (
        typeof repo !== "string" ||
        !isValidRepoSlug(repo) ||
        !cleanText(environment) ||
        !cleanText(application) ||
        typeof deploymentId !== "string" ||
        !/^[1-9]\d*$/.test(deploymentId) ||
        typeof runUrl !== "string" ||
        !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+(?:\/job\/\d+)?\/?$/.test(
          runUrl
        ) ||
        !deploymentRunId(repo, runUrl) ||
        (mode !== "normal" && mode !== "force_retry") ||
        Object.keys(args).some(
          (key) => !Object.hasOwn(parameters.properties, key)
        )
      )
        return interaction(
          "application-deletion-input-required",
          "Provide the repository, environment, application, deployment ID, run URL, and deletion mode from the current Radius deployment listing. Agent-supplied approval fields are not accepted."
        );

      const force = mode === "force_retry";
      const target = `${JSON.stringify(application)} in ${JSON.stringify(environment)} of ${repo} (deployment ${deploymentId}, ${runUrl})`;
      const unavailable = (error: unknown) =>
        ({
          kind: "unavailable",
          message: ports.redact(
            error instanceof Error ? error.message : String(error)
          )
        }) as const;
      let scope: PreparedApplicationDeletion | undefined;
      try {
        scope = await ports.prepare({
          repo,
          environment,
          application,
          deploymentId,
          runUrl,
          force
        });
      } catch (error) {
        return unavailable(error);
      }
      if (!scope)
        return interaction(
          "application-deletion-account-required",
          "Select and verify the GitHub account that will delete the application."
        );
      const prompt =
        force ?
          `As @${scope.login}, force deletion of Radius application ${target}? Forcing may leave external resources orphaned.`
        : `As @${scope.login}, delete Radius application ${target}? This tears down the application, not the environment.`;
      let confirmed: boolean | undefined;
      try {
        confirmed = await ports.confirm(prompt);
      } catch {
        confirmed = undefined;
      }
      if (confirmed === undefined)
        return interaction(
          force ?
            "force-delete-confirmation-required"
          : "delete-confirmation-required",
          prompt
        );
      if (confirmed !== true)
        return {
          kind: "refused",
          code: "application-deletion-declined"
        } as const;
      try {
        const result = await scope.execute();
        if (result.status === 200)
          return {
            kind: "dispatched",
            runUrl: result.body.runUrl,
            forced: result.body.forced
          } as const;
        if (result.dispatchUnconfirmed)
          return {
            kind: "unconfirmed",
            message:
              "GitHub may have accepted the delete workflow. Check Actions before trying again."
          } as const;
        return {
          kind: "refused",
          code: "application-deletion-refused",
          message: ports.redact(result.body.error)
        } as const;
      } catch (error) {
        return unavailable(error);
      }
    }
  };
}
