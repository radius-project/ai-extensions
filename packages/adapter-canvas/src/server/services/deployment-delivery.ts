import type { DeploymentRepairDependencies } from "@radius-project/adapter-shared";

type DeliveryPorts = Pick<
  DeploymentRepairDependencies,
  "sendRepair" | "sendNotice"
>;

/** SDK handlers are registered after construction, but belong to one runtime. */
export function createDeploymentDelivery(initial: DeliveryPorts = {}) {
  let repair = initial.sendRepair;
  let notice = initial.sendNotice;

  return {
    ports: {
      sendRepair(input) {
        if (!repair)
          throw new Error("Deployment repair delivery is unavailable.");
        return repair(input);
      },
      sendNotice(input) {
        if (!notice)
          throw new Error("Deployment failure notice delivery is unavailable.");
        return notice(input);
      }
    } satisfies Required<DeliveryPorts>,
    setDeployRepairHandoff(handler: DeliveryPorts["sendRepair"] | null): void {
      repair = handler ?? undefined;
    },
    setDeployFailureNotice(handler: DeliveryPorts["sendNotice"] | null): void {
      notice = handler ?? undefined;
    }
  };
}
