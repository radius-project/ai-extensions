import { describe, expect, it, vi } from "vitest";
import {
  createDeployMonitorService,
  type DeployMonitorDependencies
} from "./deploy-monitor.js";

describe("Canvas deployment monitor compatibility", () => {
  it.each([undefined, "models/application.bicep"])(
    "forwards execution with model %s without constructing a new owner",
    async (appFile) => {
      const unexpected = () => {
        throw new Error("Unexpected operation after a refused dispatch");
      };
      const prepareAndDispatch = vi.fn(async () => ({
        dispatched: false as const
      }));
      const dependencies: DeployMonitorDependencies = {
        dispatch: { prepareAndDispatch },
        outcome: { settle: unexpected },
        deployRadCommandsStep: "Run rad commands",
        unconfirmedRunKind: "run-unconfirmed",
        findWorkflowRun: unexpected,
        getRunDetail: unexpected,
        createStatusReader: unexpected,
        buildDeployStatusMap: unexpected,
        buildDeployMessageMap: unexpected,
        applyDeployMessages: unexpected,
        applyDeployStatusToResources: unexpected,
        settleDeployStatuses: unexpected,
        generatePortalUrl: unexpected,
        optionalString: unexpected,
        errorMessage: String,
        sleep: unexpected,
        now: () => 0
      };
      const monitor = createDeployMonitorService(dependencies);
      await monitor.run({
        entry: { state: {} },
        repo: "owner/app",
        branch: "topic",
        provider: "azure",
        requestedEnvironment: "dev",
        resources: [],
        log: () => {},
        ...(appFile ? { appFile } : {})
      });
      expect(prepareAndDispatch).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          appFile: appFile ?? ".radius/app.bicep",
          repo: "owner/app",
          branch: "topic"
        })
      );
    }
  );
});
