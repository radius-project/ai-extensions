import { describe, expect, it, vi } from "vitest";
import {
  dispatchApplicationDelete,
  type ApplicationDeleteDispatchPorts
} from "./application-delete-dispatch.js";

const request = {
  repo: "octo/app",
  environment: "dev",
  application: "demo",
  force: true
};
const files = ["delete-application.yml", "delete-azure.yml"];
const success = { code: 0, stdout: "", stderr: "" };

function fixture() {
  const ports = {
    id: () => "fixture",
    now: () => 1234,
    ensureWorkflowsCurrent: vi.fn<
      ApplicationDeleteDispatchPorts["ensureWorkflowsCurrent"]
    >(async () => ({ created: [], failed: [] })),
    deleteApplicationWorkflowFiles: files,
    findWorkflowRun: vi.fn<ApplicationDeleteDispatchPorts["findWorkflowRun"]>(
      async () => 17
    ),
    runGh: vi.fn<ApplicationDeleteDispatchPorts["runGh"]>(async () => success),
    readProcessEnv: () => ({
      GH_TOKEN: "fixture",
      NON_CREDENTIAL: "untouched"
    }),
    sleep: vi.fn<ApplicationDeleteDispatchPorts["sleep"]>(async () => {})
  } satisfies ApplicationDeleteDispatchPorts;
  return ports;
}

describe("application delete workflow dispatch", () => {
  it("syncs provider workflows and discovers only the accepted correlated run", async () => {
    const ports = fixture();
    const result = await dispatchApplicationDelete(request, ports);
    expect(ports.ensureWorkflowsCurrent).toHaveBeenCalledWith(
      request.repo,
      request.environment,
      "",
      files
    );
    expect(ports.runGh).toHaveBeenCalledWith([
      "workflow",
      "run",
      files[0],
      "-f",
      "environment=dev",
      "-f",
      "application=demo",
      "-f",
      "correlation_id=dep-fixture",
      "-f",
      "force=true",
      "--repo",
      request.repo
    ]);
    expect(ports.findWorkflowRun).not.toHaveBeenCalled();
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted")
      throw new Error("Expected an accepted dispatch");
    await expect(result.discoverRunUrl()).resolves.toBe(
      "https://github.com/octo/app/actions/runs/17"
    );
    expect(ports.findWorkflowRun).toHaveBeenCalledWith(
      request.repo,
      files[0],
      1234,
      null,
      "dep-fixture"
    );
  });

  it("does not redispatch after a keyring fallback times out", async () => {
    const ports = fixture();
    ports.runGh
      .mockResolvedValueOnce({
        code: 1,
        stdout: "",
        stderr: "HTTP 404: missing workflow scope"
      })
      .mockResolvedValueOnce({
        code: 1,
        stdout: "",
        stderr: "timeout",
        timedOut: true
      });
    await expect(
      dispatchApplicationDelete(request, ports)
    ).resolves.toMatchObject({ kind: "ambiguous" });
    expect(ports.runGh).toHaveBeenCalledTimes(2);
    expect(ports.runGh).toHaveBeenLastCalledWith(expect.any(Array), 20000, {
      NON_CREDENTIAL: "untouched"
    });
    expect(ports.sleep).not.toHaveBeenCalled();
    expect(ports.findWorkflowRun).not.toHaveBeenCalled();
  });

  it.each([
    "HTTP 502: Bad Gateway",
    "Post https://api.github.com: unexpected EOF",
    "write: connection reset by peer"
  ])(
    "keeps a lost dispatch acknowledgement unconfirmed: %s",
    async (stderr) => {
      const ports = fixture();
      ports.runGh.mockResolvedValue({ ...success, code: 1, stderr });
      await expect(
        dispatchApplicationDelete(request, ports)
      ).resolves.toMatchObject({
        kind: "ambiguous",
        error: expect.stringContaining("Check Actions before retrying")
      });
      expect(ports.runGh).toHaveBeenCalledOnce();
    }
  );

  it("uses the guarded dispatch receipt without looking up a run by correlation", async () => {
    const ports = { ...fixture(), guarded: true };
    const url = "https://github.com/octo/app/actions/runs/942";
    ports.runGh.mockResolvedValue({ ...success, stdout: `${url}\n` });
    const dispatch = await dispatchApplicationDelete(request, ports);
    if (dispatch.kind !== "accepted")
      throw new Error("Dispatch was not accepted");
    await expect(dispatch.discoverRunUrl()).resolves.toBe(url);
    expect(ports.findWorkflowRun).not.toHaveBeenCalled();
  });
});
