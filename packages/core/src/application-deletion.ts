import {
  deploymentIdentityRefusal,
  type DeploymentRow
} from "./deployment-lookup-policy.js";
import type { DeleteConflictProbe } from "./delete-conflict.js";
import { DELETE_FAILED_STATUS } from "./delete-conflict.js";

export interface ApplicationDeletionTarget {
  repo: string;
  environment: string;
  application: string;
}

export interface ApplicationDeletionSelection {
  deploymentId?: string;
  runUrl?: string;
}

export interface ApplicationDeletionRequest
  extends ApplicationDeletionTarget, ApplicationDeletionSelection {
  force: boolean;
}

type Refusal = {
  status: 400 | 409 | 503;
  body: { error: string };
  dispatchUnconfirmed?: true;
};

export type ApplicationDeletionResult =
  | Refusal
  | { status: 200; body: { success: true; runUrl: string; forced: boolean } };

export type ApplicationDeletionDispatch =
  | { kind: "accepted"; discoverRunUrl(): Promise<string> }
  | { kind: "refused" | "ambiguous"; error: string };

export interface ApplicationDeletionPorts {
  reserve(
    target: ApplicationDeletionTarget
  ): { release(): void; retain(): void } | { error: string };
  captureAcceptedDeletion(target: ApplicationDeletionTarget): () => void;
  resolveDeployment(
    target: ApplicationDeletionTarget
  ): Promise<DeploymentRow | null>;
  statusBlocksMutation(status: string): boolean;
  probeConflict(
    target: ApplicationDeletionTarget,
    selection: ApplicationDeletionSelection
  ): Promise<DeleteConflictProbe>;
  dispatch(
    request: ApplicationDeletionRequest
  ): Promise<ApplicationDeletionDispatch>;
  invalidateListing(repo: string): void;
  reportDiscoveryError(error: unknown): void;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function deleteApplication(
  request: ApplicationDeletionRequest,
  ports: ApplicationDeletionPorts
): Promise<ApplicationDeletionResult> {
  const refuse = (status: Refusal["status"], error: string): Refusal => ({
    status,
    body: { error }
  });
  try {
    const lease = ports.reserve(request);
    if ("error" in lease) return refuse(409, lease.error);
    let retain = false;
    try {
      const invalidate = ports.captureAcceptedDeletion(request);
      let current: DeploymentRow | null;
      try {
        current = await ports.resolveDeployment(request);
      } catch {
        return refuse(
          503,
          "Could not verify the current deployment state. Check your GitHub connection and try again."
        );
      }
      const identity = deploymentIdentityRefusal(
        current,
        request.application,
        request
      );
      if (identity) return refuse(identity.status, identity.error);
      if (current && ports.statusBlocksMutation(current.status))
        return refuse(
          409,
          current.status === "deleting" ?
            "This deployment is already being deleted."
          : "This application is still being deployed to the selected environment. Wait for the deployment to finish before deleting it."
        );
      if (request.force) {
        if (current?.status !== DELETE_FAILED_STATUS)
          return refuse(
            409,
            "A delete can only be forced after a previous delete of this application failed. Run the delete normally first."
          );
        let proof: DeleteConflictProbe;
        try {
          proof = await ports.probeConflict(request, {
            deploymentId: current.deploymentId,
            runUrl: current.runUrl
          });
        } catch (error) {
          return refuse(
            503,
            `The previous delete failure could not be verified, so this delete was not forced: ${message(error)}`
          );
        }
        if (proof.state !== "conflict")
          return refuse(
            409,
            proof.state === "clear" ?
              "The previous delete did not fail because a resource was stuck in a non-terminal state, so forcing would not help. Run the delete normally and address the reported failure."
            : `The previous delete failure could not be verified, so this delete was not forced: ${proof.detail}`
          );
      }
      const dispatch = await ports.dispatch(request);
      retain = dispatch.kind !== "refused";
      if (retain) lease.retain();
      if (dispatch.kind === "ambiguous")
        return { ...refuse(400, dispatch.error), dispatchUnconfirmed: true };
      if (dispatch.kind !== "accepted") return refuse(400, dispatch.error);

      ports.invalidateListing(request.repo);
      invalidate();
      let runUrl = "";
      try {
        runUrl = await dispatch.discoverRunUrl();
      } catch (error) {
        ports.reportDiscoveryError(error);
      }
      return {
        status: 200,
        body: { success: true, runUrl, forced: request.force }
      };
    } finally {
      // An ambiguous dispatch may still publish a deployment.
      if (!retain) lease.release();
    }
  } catch (error) {
    return refuse(400, message(error));
  }
}
