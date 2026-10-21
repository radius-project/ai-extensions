import { redactCredentials } from "@radius-project/core";

export interface DeploymentDeliveryRetryPorts {
  delay(milliseconds: number): Promise<void>;
  isCurrent(): boolean;
  errorMessage(error: unknown): string;
  reportError(message: string): void;
}

export async function retryDeploymentDelivery(
  callback: () => void,
  milliseconds: number,
  ports: DeploymentDeliveryRetryPorts
): Promise<void> {
  try {
    await ports.delay(milliseconds);
    if (ports.isCurrent()) callback();
  } catch (error) {
    if (!ports.isCurrent()) return;
    try {
      ports.reportError(
        redactCredentials(ports.errorMessage(error)).slice(0, 4000)
      );
    } catch {
      console.error(
        "[radius deployment] Could not report a delivery retry failure."
      );
    }
  }
}
