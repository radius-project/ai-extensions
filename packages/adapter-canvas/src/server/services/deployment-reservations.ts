import type {
  DeploymentExecutionOwner,
  DeploymentReservation
} from "../../runtime/deployment-execution-owner.js";
import type { CanvasState } from "../../shared.js";

export function createDeploymentReservationBindings(
  owner: Pick<
    DeploymentExecutionOwner,
    "reserve" | "release" | "activeReservation"
  >
) {
  return {
    active(
      state: CanvasState,
      target?: Pick<DeploymentReservation, "repo" | "environment">
    ): DeploymentReservation | undefined {
      const reservation = state.deploymentMutation;
      if (reservation) {
        const current = owner.activeReservation(reservation);
        if (current === reservation && !target) return current;
        if (current !== reservation) delete state.deploymentMutation;
      }
      return target ? owner.activeReservation(target) : undefined;
    },
    reserve(
      state: CanvasState,
      input: Pick<DeploymentReservation, "repo" | "environment" | "kind">
    ): DeploymentReservation | null {
      const reservation = owner.reserve(input, input.kind);
      if (!reservation) return null;
      state.deploymentMutation = reservation;
      return reservation;
    },
    release(state: CanvasState, reservation: DeploymentReservation): void {
      owner.release(reservation);
      if (state.deploymentMutation === reservation)
        delete state.deploymentMutation;
    }
  };
}
