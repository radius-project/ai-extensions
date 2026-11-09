import { afterEach, describe, expect, it } from "vitest";
import {
  configureOperationStore,
  createOperation,
  operations
} from "../../../src/operations.js";
import { disabledOperationStore } from "../../../src/operation-store.js";
import { FakeAws } from "./fake-aws.js";
import { FakeGitHub } from "./fake-github.js";
import {
  argument,
  freshStore,
  isLockRelease,
  MemoryDisk,
  OutsideWorld,
  restart,
  writeLabels,
  writesAfterStop
} from "./stop-points.js";

afterEach(async () => {
  operations.clear();
  await configureOperationStore(disabledOperationStore());
});

function world() {
  const aws = new FakeAws();
  aws.addCluster("shop", "us-west-2");
  const github = new FakeGitHub();
  github.addEnvironment("dev");
  return new OutsideWorld(aws, github, new MemoryDisk());
}

const LOCK = [
  "iam",
  "create-policy",
  "--policy-name",
  "radius-lock-deploy",
  "--policy-document",
  "{}"
];
const LOCK_ARN = "arn:aws:iam::123456789012:policy/radius-lock-deploy";

describe("OutsideWorld", () => {
  it("records every AWS and GitHub call in order, as read or write", async () => {
    const w = world();
    await w.runAws(["iam", "get-role", "--role-name", "x"]);
    await w.runAws(LOCK);
    await w.readGitHubJson("/repos/octo/shop");
    await w.gh([
      "variable",
      "set",
      "A",
      "--body",
      "1",
      "--env",
      "dev",
      "--repo",
      "octo/shop"
    ]);
    await w.outside("dispatch workflow", true, () => 1);

    expect(
      w.calls.map(({ index, service, command, write, answered }) => ({
        index,
        service,
        command,
        write,
        answered
      }))
    ).toEqual([
      {
        index: 0,
        service: "aws",
        command: "iam get-role",
        write: false,
        answered: true
      },
      {
        index: 1,
        service: "aws",
        command: "iam create-policy",
        write: true,
        answered: true
      },
      {
        index: 2,
        service: "github",
        command: "GET /repos/octo/shop",
        write: false,
        answered: true
      },
      {
        index: 3,
        service: "github",
        command: "gh variable set",
        write: true,
        answered: true
      },
      {
        index: 4,
        service: "github",
        command: "dispatch workflow",
        write: true,
        answered: true
      }
    ]);
    expect(w.calls[0]?.succeeded).toBe(false);
    expect(w.calls[1]?.stdout).toContain("PolicyId");
    expect(argument(w.calls[1]!, "--policy-name")).toBe("radius-lock-deploy");
    expect(argument(w.calls[1]!, "--missing")).toBe("");
  });

  it("asks for a Stop while the planned call is answered, and goes on", async () => {
    const w = world();
    let stopped = false;
    const at = w.arm(1, "stop", () => {
      stopped = true;
    });
    const seen: boolean[] = [];
    const outcome = await w.until(async () => {
      await w.runAws(["iam", "get-role", "--role-name", "x"]);
      seen.push(stopped);
      await w.runAws(LOCK);
      seen.push(stopped);
      await w.runAws(["iam", "delete-policy", "--policy-arn", LOCK_ARN]);
    });

    expect(outcome).toBe("done");
    expect(at).toBe(1);
    expect(w.stoppedAt).toBe(1);
    expect(seen).toEqual([false, true]);
    expect(w.calls[1]?.applied).toBe(true);
    // Releasing its own lock is what a stopped run still does.
    expect(writesAfterStop(w, at)).toEqual([]);
  });

  it("reports a write a run sends after it stopped", async () => {
    const w = world();
    const at = w.arm(0, "stop");
    await w.until(async () => {
      await w.runAws(["iam", "get-role", "--role-name", "x"]);
      await w.runAws(LOCK);
    });

    expect(writeLabels(writesAfterStop(w, at))).toEqual([
      "1: iam create-policy"
    ]);
  });

  it.each([
    ["crash-before", false],
    ["crash-after", true]
  ] as const)(
    "ends the process at the planned call (%s), lands it only after, and stops saving",
    async (kind, landed) => {
      const w = world();
      w.arm(0, kind);
      let after = false;
      const outcome = await w.until(async () => {
        await w.runAws(LOCK);
        after = true;
      });

      expect(outcome).toBe("crashed");
      expect(after).toBe(false);
      expect(w.calls[0]).toMatchObject({ applied: landed, answered: false });
      expect(w.aws.locks()).toHaveLength(landed ? 1 : 0);
      expect(w.disk.frozen).toBe(true);
      await w.disk.save({ version: 1, operations: [] } as never);
      expect(w.disk.saves).toBe(0);
    }
  );

  it("never answers a call a crashed process sends", async () => {
    const w = world();
    w.arm(0, "crash-before");
    await w.until(() => w.runAws(LOCK));
    let answered = false;
    void w.runAws(LOCK).then(() => {
      answered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(answered).toBe(false);
    expect(w.calls[1]?.afterCrash).toBe(true);
  });

  it("restores the saved records into a new process that is answered again", async () => {
    const w = world();
    await freshStore(w.disk);
    operations.put(
      createOperation({
        operationId: "op_saved",
        repo: "octo/shop",
        environment: "dev",
        provider: "aws"
      })
    );
    await operations.persist();
    w.arm(0, "crash-before");
    await w.until(() => w.runAws(LOCK));
    operations.put(
      createOperation({
        operationId: "op_unsaved",
        repo: "octo/other",
        environment: "dev",
        provider: "aws"
      })
    );
    await operations.persist();

    await restart(w);

    expect(
      operations.all().map((op: { operationId: string }) => op.operationId)
    ).toEqual(["op_saved"]);
    expect(w.crashed).toBe(false);
    expect((await w.runAws(["sts", "get-caller-identity"])).code).toBe(0);
    expect(w.disk.record("op_saved")).toMatchObject({
      operationId: "op_saved"
    });
    expect(w.disk.record("op_missing")).toBeUndefined();
  });

  it("reads nothing from a disk nothing was saved to", async () => {
    const disk = new MemoryDisk();
    expect(await disk.load()).toBeNull();
    expect(disk.record("op")).toBeUndefined();
  });

  it("calls only the release of a radius lock a lock release", () => {
    const call = (args: string[]) => ({
      index: 0,
      service: "aws" as const,
      command: args.slice(0, 2).join(" "),
      args,
      write: true,
      savesBefore: 0,
      applied: true,
      answered: true,
      succeeded: true,
      stdout: "",
      afterCrash: false
    });
    expect(
      isLockRelease(call(["iam", "delete-policy", "--policy-arn", LOCK_ARN]))
    ).toBe(true);
    expect(
      isLockRelease(
        call([
          "iam",
          "delete-policy",
          "--policy-arn",
          "arn:aws:iam::1:policy/other"
        ])
      )
    ).toBe(false);
    expect(
      isLockRelease(call(["iam", "delete-role", "--role-name", "x"]))
    ).toBe(false);
  });
});
