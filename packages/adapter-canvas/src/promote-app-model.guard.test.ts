import { createHash } from "node:crypto";
import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns
} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishableFiles } from "@radius-project/core/modeling";
import { portForbidden } from "@radius-project/core/lifecycle";
import { SourceAccessFault } from "../../adapter-shared/src/lifecycle/source-access-files.js";
import { hashAppBicep } from "./app-bicep-hash.js";

interface Request {
  radiusDir: string;
  stagingDir: string;
  stageInGit: boolean;
  signal?: AbortSignal;
  checkInputs?: (published?: readonly string[]) => Promise<void>;
  record?: {
    baseline: Record<string, string | null>;
    sourceBaseline: Record<string, string | null>;
    inputFiles: string[];
    validatedOutputs?: Record<string, string | null>;
  };
  validatedOutputs?: Record<string, string | null>;
}
type Command = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding
) => Omit<SpawnSyncReturns<string>, "stdout" | "stderr"> & {
  stdout: string | null;
  stderr: string | null;
};
type Dependencies = Partial<
  Pick<
    typeof fs,
    | "existsSync"
    | "mkdirSync"
    | "readdirSync"
    | "renameSync"
    | "rmSync"
    | "writeFileSync"
  >
> & {
  spawnSync?: Command;
  lstatSync?: (file: fs.PathLike) => fs.Stats;
  readFileSync?: (
    ...args: Parameters<typeof fs.readFileSync>
  ) => ReturnType<typeof fs.readFileSync>;
};
interface PromotionModule {
  beginStagedRun(
    options: { radiusDir: string; runId?: string; staleAfterMs?: number },
    dependencies?: Dependencies
  ): string;
  promoteStagedRun(
    request: Request,
    dependencies?: Dependencies
  ): Promise<{ status: "promoted"; files: string[]; gitError: string }>;
  runPromotionCommand(
    args: string[],
    output?: { log(message: string): void; error(message: string): void },
    dependencies?: Dependencies
  ): Promise<number>;
  abortStagedRun(request: { radiusDir: string; stagingDir: string }): void;
}
const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../extensions/radius/skills/radius-app-bicep/scripts/promote-app-model.mjs"
);
const promotion: PromotionModule = await import(script);
const roots = new Set<string>();
const model = "output name string = 'proposed'\n";

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function capturedOutput() {
  return {
    log: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>()
  };
}

function readRecord(request: Request): NonNullable<Request["record"]> {
  return JSON.parse(
    fs.readFileSync(path.join(request.stagingDir, "run.json"), "utf8")
  );
}

function writeRecord(request: Request, record: unknown) {
  fs.writeFileSync(
    path.join(request.stagingDir, "run.json"),
    JSON.stringify(record)
  );
}

function hash(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fixture(existing = "output name string = 'original'\n") {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".promotion-guard-"));
  roots.add(root);
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: root });
  if (initialized.status !== 0)
    throw new Error("Fixture git initialization failed.");
  const radiusDir = path.join(root, ".radius");
  fs.mkdirSync(radiusDir);
  fs.writeFileSync(path.join(radiusDir, "app.bicep"), existing);
  fs.writeFileSync(path.join(radiusDir, "bicepconfig.json"), "{}\n");
  const start = (proposal = model): Request => {
    const stagingDir = promotion.beginStagedRun({
      radiusDir,
      runId: "guard"
    });
    fs.writeFileSync(path.join(stagingDir, "app.bicep"), proposal);
    fs.writeFileSync(path.join(stagingDir, "bicepconfig.json"), "{}\n");
    fs.writeFileSync(
      path.join(stagingDir, "app.origin.json"),
      JSON.stringify({ appBicepHash: hashAppBicep(proposal) })
    );
    validate(stagingDir);
    return { radiusDir, stagingDir, stageInGit: false };
  };
  return { root, radiusDir, start };
}

function validate(stagingDir: string) {
  const recordPath = path.join(stagingDir, "run.json");
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  record.validatedOutputs = Object.fromEntries(
    publishableFiles(fs.readdirSync(stagingDir)).map((file) => [
      file,
      hash(fs.readFileSync(path.join(stagingDir, file)))
    ])
  );
  fs.writeFileSync(recordPath, JSON.stringify(record));
}

describe("injected staged promotion", () => {
  it("uses adapter-owned evidence even if the staging record is deleted", async () => {
    const target = fixture();
    const request = target.start();
    request.record = readRecord(request);
    request.validatedOutputs = request.record.validatedOutputs;
    fs.rmSync(path.join(request.stagingDir, "run.json"));
    const calls: (readonly string[] | undefined)[] = [];
    request.checkInputs = async (published) => {
      calls.push(published);
    };
    await expect(promotion.promoteStagedRun(request)).resolves.toMatchObject({
      status: "promoted"
    });
    expect(calls).toEqual([
      undefined,
      [],
      [path.join(target.radiusDir, "app.bicep")],
      [
        path.join(target.radiusDir, "app.bicep"),
        path.join(target.radiusDir, "bicepconfig.json")
      ]
    ]);
  });

  it.each([false, true])(
    "preserves the primary SourceAccessFault through rollback (failed=%s)",
    async (failRollback) => {
      const target = fixture();
      const request = target.start();
      const fault = new SourceAccessFault(portForbidden());
      request.checkInputs = async (published) => {
        if (published?.length) throw fault;
      };
      const result = promotion.promoteStagedRun(request, {
        rmSync(file, options) {
          if (
            failRollback &&
            String(file) === path.join(target.radiusDir, "app.bicep")
          )
            throw new Error("restore blocked");
          fs.rmSync(file, options);
        }
      });
      await expect(result).rejects.toMatchObject({
        cause: fault,
        rollback: failRollback ? "failed" : "restored"
      });
      await expect(result).rejects.toSatisfy(
        (error: Error) => error.cause === fault
      );
      expect(fs.existsSync(request.stagingDir)).toBe(failRollback);
    }
  );

  it.each(["app.bicep", "bicepconfig.json", "app.origin.json"])(
    "rechecks pending validated %s bytes before the first replacement",
    async (file) => {
      const target = fixture();
      const request = target.start();
      request.checkInputs = async (published) => {
        if (published?.length === 0)
          fs.appendFileSync(path.join(request.stagingDir, file), "\n");
      };
      const rename = vi.fn(fs.renameSync);
      await expect(
        promotion.promoteStagedRun(request, { renameSync: rename })
      ).rejects.toThrow("changed before replacement");
      expect(rename).not.toHaveBeenCalled();
    }
  );

  it.each(["deleted", "edited"])(
    "protects an already-published new recipe that is %s between replacements",
    async (change) => {
      const target = fixture();
      const request = target.start();
      for (const name of ["a-recipe.bicep", "z-recipe.bicep"])
        fs.writeFileSync(
          path.join(request.stagingDir, name),
          "output x int = 1\n"
        );
      validate(request.stagingDir);
      const recipe = path.join(target.radiusDir, "a-recipe.bicep");
      request.checkInputs = async (published) => {
        if (published?.includes(recipe)) {
          if (change === "deleted") fs.rmSync(recipe);
          else fs.writeFileSync(recipe, "output x int = 2\n");
        }
      };
      await expect(promotion.promoteStagedRun(request)).rejects.toMatchObject({
        rollback: "failed"
      });
      expect(fs.existsSync(path.join(target.radiusDir, "z-recipe.bicep"))).toBe(
        false
      );
      expect(fs.existsSync(recipe)).toBe(change === "edited");
      if (change === "edited")
        expect(fs.readFileSync(recipe, "utf8")).toContain("2");
    }
  );

  it("rechecks a future destination changed while reading staged outputs", async () => {
    const target = fixture();
    const request = target.start();
    let replacing = false;
    request.checkInputs = async (published) => {
      replacing = published !== undefined;
    };
    const read = vi.fn(fs.readFileSync).mockImplementation((file, options) => {
      const bytes = fs.readFileSync(file, options);
      if (
        replacing &&
        String(file) === path.join(request.stagingDir, "app.origin.json")
      )
        fs.writeFileSync(
          path.join(target.radiusDir, "app.origin.json"),
          "user origin"
        );
      return bytes;
    });
    const rename = vi.fn(fs.renameSync);
    await expect(
      promotion.promoteStagedRun(request, {
        readFileSync: read,
        renameSync: rename
      })
    ).rejects.toThrow("destination app.origin.json changed");
    expect(rename).not.toHaveBeenCalled();
    expect(
      fs.readFileSync(path.join(target.radiusDir, "app.origin.json"), "utf8")
    ).toBe("user origin");
  });

  it("refuses an output changed after the all-output check but before its rename", async () => {
    const target = fixture();
    const request = target.start();
    let replacing = false;
    request.checkInputs = async (published) => {
      replacing = published !== undefined;
    };
    const exists = vi.fn(fs.existsSync).mockImplementation((file) => {
      if (
        replacing &&
        String(file) ===
          path.join(request.stagingDir, "app.bicep.published-backup")
      )
        fs.appendFileSync(path.join(request.stagingDir, "app.bicep"), "\n");
      return fs.existsSync(file);
    });
    await expect(
      promotion.promoteStagedRun(request, { existsSync: exists })
    ).rejects.toThrow("validated output app.bicep changed");
  });

  it("refuses success when the last rename's published output disappears", async () => {
    const target = fixture();
    const request = target.start();
    const name = "z-recipe.bicep";
    fs.writeFileSync(path.join(request.stagingDir, name), "output x int = 1\n");
    validate(request.stagingDir);
    await expect(
      promotion.promoteStagedRun(request, {
        renameSync(from, to) {
          fs.renameSync(from, to);
          if (String(from) === path.join(request.stagingDir, name))
            fs.rmSync(to);
        }
      })
    ).rejects.toMatchObject({ rollback: "failed" });
    expect(
      fs.readFileSync(path.join(target.radiusDir, "app.bicep"), "utf8")
    ).toContain("original");
    expect(fs.existsSync(request.stagingDir)).toBe(true);
  });

  it("removes first-run outputs when a later rename fails without an original backup", async () => {
    const target = fixture();
    fs.rmSync(path.join(target.radiusDir, "app.bicep"));
    const request = target.start();
    await expect(
      promotion.promoteStagedRun(request, {
        renameSync(from, to) {
          if (
            String(from) === path.join(request.stagingDir, "bicepconfig.json")
          )
            throw new Error("replace blocked");
          fs.renameSync(from, to);
        }
      })
    ).rejects.toMatchObject({ rollback: "restored" });
    expect(fs.existsSync(path.join(target.radiusDir, "app.bicep"))).toBe(false);
  });

  it.each(["", "sha256:short", 42, {}, []])(
    "rejects invalid standalone baseline fingerprint %j",
    async (value) => {
      const target = fixture();
      const request = target.start();
      const record = readRecord(request);
      writeRecord(request, {
        ...record,
        baseline: { ...record.baseline, "app.bicep": value }
      });
      await expect(promotion.promoteStagedRun(request)).rejects.toThrow(
        /baseline|no record/u
      );
      expect(
        fs.readFileSync(path.join(target.radiusDir, "app.bicep"), "utf8")
      ).toContain("original");
    }
  );

  it.each(["", "unreadable", "unsafe", "sha256:short", undefined])(
    "requires valid original input fingerprint %j",
    async (value) => {
      const target = fixture();
      const request = target.start();
      const record = readRecord(request);
      writeRecord(request, {
        ...record,
        sourceBaseline: {
          ...record.sourceBaseline,
          ".radius/app.bicep": value
        }
      });
      await expect(promotion.promoteStagedRun(request)).rejects.toThrow(
        "original effective-input baseline"
      );
    }
  );

  it.each(["", null, "sha256:short"])(
    "requires exact standalone output fingerprints %j",
    async (value) => {
      const target = fixture();
      const request = target.start();
      const record = readRecord(request);
      writeRecord(request, {
        ...record,
        validatedOutputs: { ...record.validatedOutputs, "app.bicep": value }
      });
      await expect(promotion.promoteStagedRun(request)).rejects.toThrow(
        "validation record"
      );
    }
  );

  it("imports without invoking the CLI and publishes through the existing writer", async () => {
    const target = fixture();
    const request = target.start();
    const result = await promotion.promoteStagedRun(request);
    expect(result.status).toBe("promoted");
    expect(result.files).toHaveLength(3);
    expect(result.gitError).toBe("");
    expect(
      fs.readFileSync(path.join(target.radiusDir, "app.bicep"), "utf8")
    ).toBe(model);
    expect(fs.existsSync(request.stagingDir)).toBe(false);
  });

  it.each(["added", "deleted", "changed"])(
    "rejects %s modules from the original input closure",
    async (change) => {
      const original = "module part '../part.bicep' = { name: 'part' }\n";
      const target = fixture(original);
      const modulePath = path.join(target.root, "part.bicep");
      if (change !== "added")
        fs.writeFileSync(modulePath, "output x int = 1\n");
      const request = target.start();
      if (change === "deleted") fs.rmSync(modulePath);
      else fs.writeFileSync(modulePath, "output x int = 2\n");
      await expect(promotion.promoteStagedRun(request)).rejects.toThrow(
        "changed"
      );
      expect(
        fs.readFileSync(path.join(target.radiusDir, "app.bicep"), "utf8")
      ).toBe(original);
    }
  );

  it("compares proposed dependencies against their original pre-authoring bytes", async () => {
    const target = fixture();
    const modulePath = path.join(target.root, "part.bicep");
    fs.writeFileSync(modulePath, "output x int = 1\n");
    const request = target.start(
      "module part '../part.bicep' = { name: 'part' }\n"
    );
    fs.writeFileSync(modulePath, "output x int = 2\n");
    await expect(promotion.promoteStagedRun(request)).rejects.toThrow(
      "changed"
    );
  });

  it("preserves unrelated edits while publishing", async () => {
    const target = fixture();
    const file = path.join(target.root, "notes.txt");
    fs.writeFileSync(file, "old");
    const request = target.start();
    fs.writeFileSync(file, "user edit");
    await promotion.promoteStagedRun(request);
    expect(fs.readFileSync(file, "utf8")).toBe("user edit");
  });

  it("rechecks exact staged bytes after the injected asynchronous guard", async () => {
    const target = fixture();
    const request = target.start();
    request.checkInputs = async () => {
      fs.appendFileSync(
        path.join(request.stagingDir, "bicepconfig.json"),
        "\n"
      );
    };
    await expect(promotion.promoteStagedRun(request)).rejects.toThrow(
      "changed before replacement"
    );
    expect(fs.existsSync(path.join(target.radiusDir, "app.origin.json"))).toBe(
      false
    );
  });

  it("refuses cancellation before replacement and cleans staging once", async () => {
    const target = fixture();
    const request = target.start();
    const controller = new AbortController();
    request.signal = controller.signal;
    controller.abort();
    let removals = 0;
    await expect(
      promotion.promoteStagedRun(request, {
        rmSync(file, options) {
          removals++;
          fs.rmSync(file, options);
        }
      })
    ).rejects.toThrow("cancelled");
    expect(removals).toBe(1);
    expect(fs.existsSync(request.stagingDir)).toBe(false);
  });

  it("fences cancellation after the asynchronous precondition", async () => {
    const target = fixture();
    const request = target.start();
    const controller = new AbortController();
    request.signal = controller.signal;
    request.checkInputs = async () => {
      controller.abort();
    };
    await expect(promotion.promoteStagedRun(request)).rejects.toMatchObject({
      code: "PROMOTION_CANCELLED"
    });
    expect(fs.existsSync(path.join(target.radiusDir, "app.origin.json"))).toBe(
      false
    );
  });

  it("restores prior bytes when cancellation arrives between replacements", async () => {
    const target = fixture();
    const before = fs.readFileSync(
      path.join(target.radiusDir, "app.bicep"),
      "utf8"
    );
    const request = target.start();
    const controller = new AbortController();
    request.signal = controller.signal;
    await expect(
      promotion.promoteStagedRun(request, {
        renameSync(from, to) {
          fs.renameSync(from, to);
          if (String(from) === path.join(request.stagingDir, "app.bicep"))
            controller.abort();
        }
      })
    ).rejects.toMatchObject({
      code: "PROMOTION_CANCELLED",
      rollback: "restored"
    });
    expect(
      fs.readFileSync(path.join(target.radiusDir, "app.bicep"), "utf8")
    ).toBe(before);
  });

  it("rolls back earlier replacements when a later replacement fails", async () => {
    const target = fixture();
    const before = fs.readFileSync(
      path.join(target.radiusDir, "app.bicep"),
      "utf8"
    );
    const request = target.start();
    await expect(
      promotion.promoteStagedRun(request, {
        renameSync(from, to) {
          if (
            String(from) === path.join(request.stagingDir, "bicepconfig.json")
          ) {
            throw new Error("replacement failed");
          }
          fs.renameSync(from, to);
        }
      })
    ).rejects.toMatchObject({ rollback: "restored" });
    expect(
      fs.readFileSync(path.join(target.radiusDir, "app.bicep"), "utf8")
    ).toBe(before);
    expect(fs.existsSync(request.stagingDir)).toBe(false);
  });

  it("rechecks all inputs before the next replacement and rolls back owned bytes", async () => {
    const original = "module part '../part.bicep' = { name: 'part' }\n";
    const target = fixture(original);
    const modulePath = path.join(target.root, "part.bicep");
    fs.writeFileSync(modulePath, "output x int = 1\n");
    const request = target.start();
    await expect(
      promotion.promoteStagedRun(request, {
        renameSync(from, to) {
          fs.renameSync(from, to);
          if (String(from) === path.join(request.stagingDir, "app.bicep")) {
            fs.writeFileSync(modulePath, "output x int = 2\n");
          }
        }
      })
    ).rejects.toMatchObject({ rollback: "restored" });
    expect(fs.readFileSync(modulePath, "utf8")).toContain("2");
    expect(
      fs.readFileSync(path.join(target.radiusDir, "app.bicep"), "utf8")
    ).toBe(original);
  });

  it("retains recovery files and preserves concurrent edits when rollback cannot restore", async () => {
    const target = fixture();
    const request = target.start();
    await expect(
      promotion.promoteStagedRun(request, {
        renameSync(from, to) {
          fs.renameSync(from, to);
          if (String(from) === path.join(request.stagingDir, "app.bicep")) {
            fs.writeFileSync(String(to), "concurrent edit");
          }
        }
      })
    ).rejects.toMatchObject({ rollback: "failed" });
    expect(
      fs.readFileSync(path.join(target.radiusDir, "app.bicep"), "utf8")
    ).toBe("concurrent edit");
    expect(
      fs.existsSync(path.join(request.stagingDir, "app.bicep.published-backup"))
    ).toBe(true);
  });

  it("keeps the primary refusal ahead of cleanup failures", async () => {
    const target = fixture();
    const request = target.start();
    fs.writeFileSync(
      path.join(request.stagingDir, "app.bicep"),
      "invalid origin"
    );
    await expect(
      promotion.promoteStagedRun(request, {
        rmSync() {
          throw new Error("cleanup blocked");
        }
      })
    ).rejects.toThrow(/origin record.*Cleanup failed: cleanup blocked/su);
  });

  it("reports cleanup failure after writes as published, not rolled back", async () => {
    const target = fixture();
    const request = target.start();
    await expect(
      promotion.promoteStagedRun(request, {
        rmSync() {
          throw new Error("cleanup blocked");
        }
      })
    ).rejects.toMatchObject({ published: true });
    expect(
      fs.readFileSync(path.join(target.radiusDir, "app.bicep"), "utf8")
    ).toBe(model);
  });

  it("refuses a repeated consumed run without modifying the published model", async () => {
    const target = fixture();
    const request = target.start();
    await promotion.promoteStagedRun(request);
    await expect(promotion.promoteStagedRun(request)).rejects.toThrow(
      "No staged modeling run"
    );
    expect(
      fs.readFileSync(path.join(target.radiusDir, "app.bicep"), "utf8")
    ).toBe(model);
  });

  it("propagates the injected precondition failure without writing", async () => {
    const target = fixture();
    const request = target.start();
    request.checkInputs = async () => {
      throw new Error("source capture failed");
    };
    await expect(promotion.promoteStagedRun(request)).rejects.toThrow(
      "source capture failed"
    );
    expect(fs.existsSync(path.join(target.radiusDir, "app.origin.json"))).toBe(
      false
    );
  });

  it.each(["changed", "deleted", "added"])(
    "refuses %s original configuration",
    async (change) => {
      const target = fixture();
      const config = path.join(target.root, "bicepconfig.json");
      if (change !== "added") fs.writeFileSync(config, "{}\n");
      const request = target.start();
      if (change === "deleted") fs.rmSync(config);
      else fs.writeFileSync(config, "{}\n\n");
      await expect(promotion.promoteStagedRun(request)).rejects.toThrow(
        "changed"
      );
    }
  );

  it("detects binary extension changes that decode to identical text", async () => {
    const target = fixture("extension './extension.tgz' as custom\n");
    const binary = path.join(target.radiusDir, "extension.tgz");
    fs.writeFileSync(binary, Buffer.from([0x80]));
    const request = target.start();
    fs.writeFileSync(binary, Buffer.from([0x81]));
    await expect(promotion.promoteStagedRun(request)).rejects.toThrow(
      "changed"
    );
  });

  it("detects effective load-file changes through a nested module", async () => {
    const original = "module part '../modules/part.bicep' = { name: 'part' }\n";
    const target = fixture(original);
    fs.mkdirSync(path.join(target.root, "modules"));
    fs.writeFileSync(
      path.join(target.root, "modules", "part.bicep"),
      "var data = loadTextContent('./data.txt')\n"
    );
    const data = path.join(target.root, "modules", "data.txt");
    fs.writeFileSync(data, "old");
    const request = target.start();
    fs.writeFileSync(data, "new");
    await expect(promotion.promoteStagedRun(request)).rejects.toThrow(
      "changed"
    );
  });

  it("rejects unsafe output parent links without touching their targets", async () => {
    const target = fixture();
    const request = target.start();
    const actual = path.join(target.root, "original-radius");
    fs.renameSync(target.radiusDir, actual);
    fs.symlinkSync(actual, target.radiusDir, "junction");
    await expect(promotion.promoteStagedRun(request)).rejects.toThrow(
      "Unsafe promotion path"
    );
    expect(
      fs.existsSync(path.join(actual, ".staging-guard", "app.bicep"))
    ).toBe(true);
  });

  it.each(["app.bicep", "custom-recipe-pack.bicep", ".gitignore"])(
    "rejects hardlinked destination %s before writing any outputs",
    async (file) => {
      const target = fixture();
      const request = target.start();
      const linked = path.join(target.root, "linked");
      fs.writeFileSync(linked, "external");
      const destination = path.join(target.radiusDir, file);
      fs.rmSync(destination, { force: true });
      fs.linkSync(linked, destination);
      if (file === "custom-recipe-pack.bicep") {
        fs.writeFileSync(
          path.join(request.stagingDir, file),
          "output x int = 1\n"
        );
        validate(request.stagingDir);
      }
      await expect(promotion.promoteStagedRun(request)).rejects.toThrow(
        "Unsafe promotion path"
      );
      expect(fs.readFileSync(linked, "utf8")).toBe("external");
      expect(
        fs.existsSync(path.join(target.radiusDir, "app.origin.json"))
      ).toBe(false);
    }
  );

  it.each([
    "../outside.bicep",
    "C:\\outside.bicep",
    "C:outside.bicep",
    "\\\\server\\outside.bicep"
  ])("rejects an unconfined staging reference %s", async (reference) => {
    const target = fixture();
    const request = target.start();
    request.stagingDir = reference;
    await expect(promotion.promoteStagedRun(request)).rejects.toThrow(
      "staging directory must"
    );
  });

  it("requires exact validation evidence in standalone run records", async () => {
    const target = fixture();
    const request = target.start();
    const file = path.join(request.stagingDir, "run.json");
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    delete record.validatedOutputs;
    fs.writeFileSync(file, JSON.stringify(record));
    await expect(promotion.promoteStagedRun(request)).rejects.toThrow(
      "validation record"
    );
  });

  it.each([
    ["sourceBaseline", null],
    ["inputFiles", null],
    ["inputFiles", ["../outside.bicep"]],
    ["baseline", { "../outside.bicep": null }]
  ])("rejects malformed original evidence %s", async (key, value) => {
    const target = fixture();
    const request = target.start();
    const file = path.join(request.stagingDir, "run.json");
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    record[String(key)] = value;
    fs.writeFileSync(file, JSON.stringify(record));
    await expect(promotion.promoteStagedRun(request)).rejects.toThrow();
    expect(fs.existsSync(path.join(target.radiusDir, "app.origin.json"))).toBe(
      false
    );
  });

  it("refuses duplicate begin without replacing an active staging record", () => {
    const target = fixture();
    const request = target.start();
    const before = fs.readFileSync(
      path.join(request.stagingDir, "run.json"),
      "utf8"
    );
    expect(() =>
      promotion.beginStagedRun({ radiusDir: target.radiusDir, runId: "guard" })
    ).toThrow("already exists");
    expect(
      fs.readFileSync(path.join(request.stagingDir, "run.json"), "utf8")
    ).toBe(before);
  });

  it("never removes an active run through a traversal spelling", async () => {
    const target = fixture();
    const request = target.start();
    request.stagingDir = `${target.radiusDir}${path.sep}other${path.sep}..${path.sep}.staging-guard`;
    await expect(promotion.promoteStagedRun(request)).rejects.toThrow(
      "traversal"
    );
    expect(
      fs.existsSync(path.join(target.radiusDir, ".staging-guard", "run.json"))
    ).toBe(true);
  });

  it("does not overwrite preexisting recovery files", async () => {
    const target = fixture();
    const request = target.start();
    fs.writeFileSync(
      path.join(request.stagingDir, "app.bicep.published-backup"),
      "recovery"
    );
    await expect(promotion.promoteStagedRun(request)).rejects.toThrow(
      "Recovery path already exists"
    );
    expect(
      fs.readFileSync(
        path.join(request.stagingDir, "app.bicep.published-backup"),
        "utf8"
      )
    ).toBe("recovery");
    expect(fs.existsSync(path.join(target.radiusDir, "app.origin.json"))).toBe(
      false
    );
  });

  it.each([
    "module part source = { name: 'part' }\n",
    "var data = loadTextContent(fileName)\n",
    "import * as helpers from './helpers.bicep'\n",
    "module part '../../../escape.bicep' = { name: 'part' }\n"
  ])(
    "refuses unsupported input closure without leaving a staging run",
    (source) => {
      const target = fixture(source);
      expect(() => target.start()).toThrow();
      expect(fs.existsSync(path.join(target.radiusDir, ".staging-guard"))).toBe(
        false
      );
    }
  );

  it("retains legacy registry references without treating them as captured local inputs", () => {
    const target = fixture(
      "module part 'br:example.test/module:v1' = { name: 'part' }\n"
    );
    const request = target.start();
    const record = JSON.parse(
      fs.readFileSync(path.join(request.stagingDir, "run.json"), "utf8")
    );
    expect(record.inputFiles).toContain(".radius/app.bicep");
    expect(
      record.inputFiles.some((file: string) => file.startsWith("br:"))
    ).toBe(false);
  });

  it("checks a local extension selected by configuration", async () => {
    const target = fixture();
    fs.writeFileSync(
      path.join(target.radiusDir, "bicepconfig.json"),
      JSON.stringify({ extensions: { custom: { source: "./types.tgz" } } })
    );
    const types = path.join(target.radiusDir, "types.tgz");
    fs.writeFileSync(types, "old");
    const request = target.start();
    fs.writeFileSync(types, "new");
    await expect(promotion.promoteStagedRun(request)).rejects.toThrow(
      "changed"
    );
  });

  it.each(["", "{", "[]", '{"baseline":42}', '{"baseline":{"app.bicep":42}}'])(
    "refuses malformed run records %s",
    async (record) => {
      const target = fixture();
      const request = target.start();
      fs.writeFileSync(path.join(request.stagingDir, "run.json"), record);
      await expect(promotion.promoteStagedRun(request)).rejects.toThrow(
        "no record"
      );
    }
  );

  it.each([
    "",
    "{",
    "[]",
    "42",
    '{"appBicepHash":""}',
    '{"appBicepHash":"sha256:other"}'
  ])("refuses unusable origin evidence %s", async (origin) => {
    const target = fixture();
    const request = target.start();
    fs.writeFileSync(path.join(request.stagingDir, "app.origin.json"), origin);
    await expect(promotion.promoteStagedRun(request)).rejects.toThrow(
      "origin record"
    );
  });

  it("aborts idempotently and refuses aborting outside the authorized directory", () => {
    const target = fixture();
    const request = target.start();
    promotion.abortStagedRun(request);
    promotion.abortStagedRun(request);
    expect(fs.existsSync(request.stagingDir)).toBe(false);
    expect(() =>
      promotion.abortStagedRun({ ...request, stagingDir: "" })
    ).toThrow("required");
    expect(() =>
      promotion.abortStagedRun({ ...request, stagingDir: target.root })
    ).toThrow("directly inside");
  });

  it("runs begin and abort through CLI dispatch but rejects synthetic validation records", async () => {
    const target = fixture();
    const messages: string[] = [];
    const errors: string[] = [];
    const output = {
      log: (message: string) => messages.push(message),
      error: (message: string) => errors.push(message)
    };
    const common = ["--radius-dir", target.radiusDir];
    expect(
      await promotion.runPromotionCommand(
        [...common, "--begin", "--run-id", "cli"],
        output
      )
    ).toBe(0);
    const directory = messages[0];
    fs.writeFileSync(path.join(directory, "app.bicep"), model);
    fs.writeFileSync(path.join(directory, "bicepconfig.json"), "{}");
    fs.writeFileSync(
      path.join(directory, "app.origin.json"),
      JSON.stringify({ appBicepHash: hashAppBicep(model) })
    );
    validate(directory);
    expect(
      await promotion.runPromotionCommand(
        [...common, "--staging", directory],
        output
      )
    ).toBe(1);
    expect(errors[0]).toContain("successful agent compile");
    expect(
      await promotion.runPromotionCommand(
        [...common, "--begin", "--stale-after-ms", "0"],
        output
      )
    ).toBe(0);
    const next = messages.at(-1);
    expect(typeof next).toBe("string");
    expect(
      await promotion.runPromotionCommand(
        [...common, "--abort", "--staging", String(next)],
        output
      )
    ).toBe(0);
    expect(
      await promotion.runPromotionCommand(
        [...common, "--staging", "--abort"],
        output
      )
    ).toBe(1);
    expect(errors).toHaveLength(2);
  });

  it("sweeps only expired staging runs", async () => {
    const target = fixture();
    const request = target.start();
    fs.utimesSync(request.stagingDir, new Date(0), new Date(0));
    const messages: string[] = [];
    const result = await promotion.runPromotionCommand(
      [
        "--begin",
        "--radius-dir",
        target.radiusDir,
        "--run-id",
        "..",
        "--stale-after-ms",
        "invalid"
      ],
      {
        log: (message) => messages.push(message),
        error: (message) => {
          throw new Error(message);
        }
      }
    );
    expect(result).toBe(0);
    expect(fs.existsSync(request.stagingDir)).toBe(false);
    expect(messages[0]).toContain(".staging-run");
  });

  it("never sweeps recovery backups left by interrupted or failed rollback", () => {
    const target = fixture();
    const request = target.start();
    const backup = path.join(request.stagingDir, "app.bicep.published-backup");
    fs.writeFileSync(backup, "recoverable original");
    fs.utimesSync(request.stagingDir, new Date(0), new Date(0));

    promotion.beginStagedRun({ radiusDir: target.radiusDir, runId: "next" });

    expect(fs.readFileSync(backup, "utf8")).toBe("recoverable original");
    expect(() => promotion.abortStagedRun(request)).toThrow(
      "Recovery files were retained"
    );
    expect(fs.readFileSync(backup, "utf8")).toBe("recoverable original");
  });

  it("retains recovery backups even when an earlier preflight check refuses", async () => {
    const target = fixture();
    const request = target.start();
    const backup = path.join(request.stagingDir, "app.bicep.published-backup");
    fs.writeFileSync(backup, "original");
    fs.writeFileSync(path.join(request.stagingDir, "app.bicep"), "unverified");

    await expect(promotion.promoteStagedRun(request)).rejects.toMatchObject({
      retainStaging: true
    });

    expect(fs.readFileSync(backup, "utf8")).toBe("original");
  });

  it.each([".staging-*/\n", "# local", "# local\n"])(
    "preserves existing ignore contents %j and stages only its own edits",
    async (ignore) => {
      const target = fixture();
      const request = target.start();
      const ignoreFile = path.join(target.radiusDir, ".gitignore");
      fs.writeFileSync(ignoreFile, ignore);
      const commands = vi.fn<Command>(spawnSync);
      expect(
        await promotion.promoteStagedRun(
          { ...request, stageInGit: true },
          { spawnSync: commands }
        )
      ).toMatchObject({ status: "promoted", gitError: "" });
      const add = commands.mock.calls.find(
        ([, args]) => Array.isArray(args) && args.includes("add")
      );
      expect(add).toBeDefined();
      expect(add?.[1]).toEqual(
        expect.arrayContaining(
          publishableFiles([]).map((name) => path.join(target.radiusDir, name))
        )
      );
      if (ignore.startsWith(".staging")) {
        expect(add?.[1]).not.toContain(ignoreFile);
        expect(fs.readFileSync(ignoreFile, "utf8")).toBe(ignore);
      } else {
        expect(add?.[1]).toContain(ignoreFile);
        expect(fs.readFileSync(ignoreFile, "utf8")).toBe(
          `${ignore.trimEnd()}\n.staging-*/\n`
        );
      }
    }
  );

  it.each([
    { error: undefined, stderr: "index is locked", message: "index is locked" },
    {
      error: Object.assign(new Error("git executable unavailable"), {
        code: "ENOENT"
      }),
      stderr: "",
      message: "git executable unavailable"
    },
    { error: undefined, stderr: "", message: "git add failed" }
  ])(
    "reports published-but-not-staged command failure: $message",
    async ({ error, stderr, message }) => {
      const target = fixture();
      const request = target.start();
      const commands = vi
        .fn<Command>(spawnSync)
        .mockImplementation((command, args, options) => {
          if (Array.isArray(args) && args.includes("add")) {
            return {
              pid: 0,
              output: [],
              stdout: "",
              stderr,
              status: 1,
              signal: null,
              error
            };
          }
          return spawnSync(command, args, options);
        });
      expect(
        await promotion.promoteStagedRun(
          { ...request, stageInGit: true },
          { spawnSync: commands }
        )
      ).toMatchObject({ status: "promoted", gitError: message });
      expect(
        fs.readFileSync(path.join(target.radiusDir, "app.bicep"), "utf8")
      ).toBe(model);
    }
  );

  it.each(["failure", "empty-root", "missing-stdout"])(
    "uses the radius parent when git cannot supply a root: %s",
    async (mode) => {
      const target = fixture();
      const commands = vi.fn<Command>().mockReturnValue({
        pid: 0,
        output: [],
        stdout: mode === "missing-stdout" ? null : "",
        stderr: "",
        status: mode === "failure" ? 1 : 0,
        signal: null
      });
      const directory = promotion.beginStagedRun(
        { radiusDir: target.radiusDir, runId: "fallback" },
        { spawnSync: commands }
      );
      const record = readRecord({
        radiusDir: target.radiusDir,
        stagingDir: directory,
        stageInGit: false
      });
      expect(record.sourceBaseline[".radius/app.bicep"]).toBe(
        hash(fs.readFileSync(path.join(target.radiusDir, "app.bicep")))
      );
      expect(record.inputFiles).toContain("bicepconfig.json");
    }
  );

  it("reports published state when writer finalization fails", async () => {
    const target = fixture();
    const request = target.start();
    const commands = vi.fn<Command>(spawnSync);
    await expect(
      promotion.promoteStagedRun(request, {
        spawnSync: commands,
        rmSync() {
          throw new Error("staging cleanup locked");
        }
      })
    ).rejects.toMatchObject({
      published: true,
      message: expect.stringContaining("finalization failed")
    });
    expect(
      commands.mock.calls.some(
        ([, args]) => Array.isArray(args) && args.includes("add")
      )
    ).toBe(false);
    expect(
      fs.readFileSync(path.join(target.radiusDir, "app.bicep"), "utf8")
    ).toBe(model);
  });

  it("defaults CLI output and radius path while rejecting a missing staging argument", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await promotion.runPromotionCommand([])).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("--staging"));
  });

  it.each([
    null,
    {},
    { radiusDir: 4, stagingDir: "" },
    { radiusDir: "", stagingDir: 4 }
  ])(
    "rejects malformed API arguments %j before filesystem access",
    async (request) => {
      const read = vi.fn(fs.readFileSync);
      await expect(
        Reflect.apply(promotion.promoteStagedRun, undefined, [
          request,
          { readFileSync: read }
        ])
      ).rejects.toThrow("requires radiusDir");
      expect(read).not.toHaveBeenCalled();
    }
  );

  it.each([
    "app.bicep",
    "bicepconfig.json",
    "app.origin.json",
    "custom-types.tgz"
  ])(
    "reports a missing required output %s through the command seam",
    async (file) => {
      const target = fixture();
      const request = target.start();
      if (file.startsWith("custom-"))
        fs.writeFileSync(
          path.join(request.stagingDir, "custom-types.yaml"),
          "types: {}"
        );
      else fs.rmSync(path.join(request.stagingDir, file));
      const output = capturedOutput();
      expect(
        await promotion.runPromotionCommand(
          ["--radius-dir", target.radiusDir, "--staging", request.stagingDir],
          output
        )
      ).toBe(1);
      expect(output.error).toHaveBeenCalledWith(
        expect.stringContaining(`missing ${file}`)
      );
      expect(fs.existsSync(request.stagingDir)).toBe(false);
    }
  );

  it.each(["", " \n"])("reports empty staged models %j", async (content) => {
    const target = fixture();
    const request = target.start();
    fs.writeFileSync(path.join(request.stagingDir, "app.bicep"), content);
    await expect(promotion.promoteStagedRun(request)).rejects.toThrow(
      "model is empty"
    );
  });

  it("refuses a staging path that names a regular file without deleting it", async () => {
    const target = fixture();
    const stagingDir = path.join(target.radiusDir, ".staging-file");
    fs.writeFileSync(stagingDir, "keep");
    await expect(
      promotion.promoteStagedRun({
        radiusDir: target.radiusDir,
        stagingDir,
        stageInGit: false
      })
    ).rejects.toThrow("not a real directory");
    expect(fs.readFileSync(stagingDir, "utf8")).toBe("keep");
  });

  it.each(["folder.", "folder ", "folder:stream", "C:relative", "../escape"])(
    "rejects unsafe radius path spelling %s",
    (name) => {
      const target = fixture();
      const radiusDir =
        name.startsWith("C:") ? name : `${target.root}${path.sep}${name}`;
      expect(() => promotion.beginStagedRun({ radiusDir })).toThrow(
        "Unsafe promotion path"
      );
    }
  );

  it.each(["\\\\server\\share\\radius", "//server/share/radius"])(
    "rejects UNC root %s before attempting to access a workspace",
    (radiusDir) => {
      const mkdir = vi.fn(fs.mkdirSync);
      const stat = vi
        .fn<(file: fs.PathLike) => fs.Stats>()
        .mockImplementation(() => {
          throw Object.assign(new Error("not found"), { code: "ENOENT" });
        });
      expect(() =>
        promotion.beginStagedRun(
          { radiusDir },
          { lstatSync: stat, mkdirSync: mkdir }
        )
      ).toThrow("UNC promotion paths");
      expect(stat).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
    }
  );

  it("fails closed on an inaccessible ancestor", () => {
    const target = fixture();
    const fault = Object.assign(new Error("directory locked"), {
      code: "EACCES"
    });
    expect(() =>
      promotion.beginStagedRun(
        { radiusDir: target.radiusDir },
        {
          lstatSync() {
            throw fault;
          }
        }
      )
    ).toThrow(fault);
  });

  it("refuses an unreadable original input instead of treating it as absent", () => {
    const target = fixture();
    const read = vi.fn(fs.readFileSync).mockImplementation((file, options) => {
      if (
        options === undefined &&
        String(file) === path.join(target.radiusDir, "app.bicep")
      )
        throw Object.assign(new Error("sharing violation"), { code: "EBUSY" });
      return fs.readFileSync(file, options);
    });
    expect(() =>
      promotion.beginStagedRun(
        { radiusDir: target.radiusDir },
        { readFileSync: read }
      )
    ).toThrow("Cannot read promotion input");
    expect(fs.readdirSync(target.radiusDir)).toEqual([
      "app.bicep",
      "bicepconfig.json"
    ]);
  });

  it("captures unsafe unrelated files without following them", () => {
    const target = fixture();
    const file = path.join(target.root, "unrelated");
    fs.writeFileSync(file, "unrelated bytes");
    fs.linkSync(file, path.join(target.root, "unrelated-link"));
    const request = target.start();
    expect(readRecord(request).sourceBaseline["unrelated-link"]).toBe("unsafe");
    expect(fs.readFileSync(file, "utf8")).toBe("unrelated bytes");
  });

  it.each(["string", "remote"])(
    "accepts %s extension configuration without losing input tracking",
    async (kind) => {
      const target = fixture();
      fs.writeFileSync(
        path.join(target.radiusDir, "bicepconfig.json"),
        JSON.stringify({
          extensions: {
            custom:
              kind === "string" ? "./types.tgz" : "br:example.invalid/types:v1"
          }
        })
      );
      fs.writeFileSync(path.join(target.radiusDir, "types.tgz"), "bytes");
      const request = target.start();
      await expect(promotion.promoteStagedRun(request)).resolves.toMatchObject({
        status: "promoted"
      });
    }
  );

  it.each([null, {}, 42])(
    "refuses extension configuration with unsupported source %j",
    (source) => {
      const target = fixture();
      fs.writeFileSync(
        path.join(target.radiusDir, "bicepconfig.json"),
        JSON.stringify({ extensions: { custom: source } })
      );
      expect(() => target.start()).toThrow("no supported source");
    }
  );

  it("refuses a git root outside the radius ancestry", () => {
    const target = fixture();
    const commands = vi.fn<Command>().mockReturnValue({
      pid: 0,
      output: [],
      stdout: path.join(target.root, "other"),
      stderr: "",
      status: 0,
      signal: null
    });
    fs.mkdirSync(path.join(target.root, "other"));
    expect(() =>
      promotion.beginStagedRun(
        { radiusDir: target.radiusDir },
        { spawnSync: commands }
      )
    ).toThrow(/outside the workspace|escapes|Unsafe/u);
  });

  it.each([["app.bicep"], ["app.bicep", "bicepconfig.json"]])(
    "reports incomplete managed baseline coverage for %j",
    async (...files) => {
      const target = fixture();
      const request = target.start();
      request.record = readRecord(request);
      for (const file of files) delete request.record.baseline[file];
      await expect(promotion.promoteStagedRun(request)).rejects.toThrow(
        files.length === 1 ?
          "Your version of that file is intact"
        : "Your versions of those files are intact"
      );
      expect(
        fs.readFileSync(path.join(target.radiusDir, "app.bicep"), "utf8")
      ).toContain("original");
    }
  );

  it.each(["baseline", "current"])(
    "distinguishes unreadable %s evidence from absence",
    async (unreadable) => {
      const target = fixture();
      const request = target.start();
      request.record = readRecord(request);
      request.record.baseline["notes.txt"] =
        unreadable === "baseline" ? "unreadable" : null;
      const read = vi
        .fn(fs.readFileSync)
        .mockImplementation((file, options) => {
          if (
            unreadable === "current" &&
            String(file) === path.join(target.radiusDir, "notes.txt")
          )
            throw Object.assign(new Error("sharing violation"), {
              code: "EBUSY"
            });
          return fs.readFileSync(file, options);
        });
      await expect(
        promotion.promoteStagedRun(request, { readFileSync: read })
      ).rejects.toThrow(".radius/notes.txt could not be read");
      expect(
        fs.existsSync(path.join(target.radiusDir, "app.origin.json"))
      ).toBe(false);
    }
  );

  it("records unreadable managed evidence at begin rather than mistaking it for absence", () => {
    const target = fixture();
    let recordedInputs = false;
    const read = vi.fn(fs.readFileSync).mockImplementation((file, options) => {
      if (String(file) === path.join(target.root, "bicepconfig.json"))
        recordedInputs = true;
      if (
        recordedInputs &&
        String(file) === path.join(target.radiusDir, "app.bicep")
      )
        throw Object.assign(new Error("sharing violation"), { code: "EBUSY" });
      return fs.readFileSync(file, options);
    });
    const stagingDir = promotion.beginStagedRun(
      { radiusDir: target.radiusDir },
      { readFileSync: read }
    );
    const record = readRecord({
      radiusDir: target.radiusDir,
      stagingDir,
      stageInGit: false
    });
    expect(record.baseline["app.bicep"]).toBe("unreadable");
  });

  it("captures but does not authorize unrelated unreadable source bytes", () => {
    const target = fixture();
    const note = path.join(target.root, "notes.txt");
    fs.writeFileSync(note, "user data");
    const read = vi.fn(fs.readFileSync).mockImplementation((file, options) => {
      if (String(file) === note)
        throw Object.assign(new Error("locked"), { code: "EBUSY" });
      return fs.readFileSync(file, options);
    });
    const stagingDir = promotion.beginStagedRun(
      { radiusDir: target.radiusDir },
      { readFileSync: read }
    );
    expect(
      readRecord({ radiusDir: target.radiusDir, stagingDir, stageInGit: false })
        .sourceBaseline["notes.txt"]
    ).toBe("unreadable");
  });

  it("rolls back cancellation from the final rename and retains its cancellation code", async () => {
    const target = fixture();
    const request = target.start();
    const controller = new AbortController();
    request.signal = controller.signal;
    await expect(
      promotion.promoteStagedRun(request, {
        renameSync(from, to) {
          fs.renameSync(from, to);
          if (String(from) === path.join(request.stagingDir, "app.origin.json"))
            controller.abort();
        }
      })
    ).rejects.toMatchObject({
      code: "PROMOTION_CANCELLED",
      rollback: "restored"
    });
    expect(
      fs.readFileSync(path.join(target.radiusDir, "app.bicep"), "utf8")
    ).toContain("original");
    expect(fs.existsSync(path.join(target.radiusDir, "app.origin.json"))).toBe(
      false
    );
  });

  it("checks the whole custom-type pair and ignores unrelated staged notes", async () => {
    const target = fixture();
    const request = target.start();
    for (const name of [
      "custom-types.yaml",
      "custom-types.tgz",
      "custom-recipe-pack.bicep",
      "postgres-recipe.bicep"
    ])
      fs.writeFileSync(
        path.join(request.stagingDir, name),
        name.endsWith(".bicep") ? "// recipe\n" : "artifact"
      );
    fs.writeFileSync(
      path.join(request.stagingDir, "notes.txt"),
      "not published"
    );
    validate(request.stagingDir);
    const result = await promotion.promoteStagedRun(request);
    expect(result.files).toHaveLength(7);
    expect(fs.existsSync(path.join(target.radiusDir, "notes.txt"))).toBe(false);
    expect(
      fs.readFileSync(path.join(target.radiusDir, "custom-types.tgz"), "utf8")
    ).toBe("artifact");
  });

  it("does not sweep non-staging directories or linked staging entries", () => {
    const target = fixture();
    const outside = path.join(target.root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep"), "original");
    fs.symlinkSync(
      outside,
      path.join(target.radiusDir, ".staging-link"),
      "junction"
    );
    fs.mkdirSync(path.join(target.radiusDir, "keep"));
    const stagingDir = promotion.beginStagedRun({
      radiusDir: target.radiusDir,
      staleAfterMs: 0
    });
    expect(fs.existsSync(stagingDir)).toBe(true);
    expect(fs.existsSync(path.join(target.radiusDir, "keep"))).toBe(true);
    expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe(
      "original"
    );
  });

  it("fails without deleting a staging directory that disappears during its identity check", async () => {
    const target = fixture();
    const request = target.start();
    const exists = vi.fn(fs.existsSync).mockImplementation((file) => {
      const present = fs.existsSync(file);
      if (String(file) === request.stagingDir && present)
        fs.rmSync(request.stagingDir, { recursive: true, force: true });
      return present;
    });
    await expect(
      promotion.promoteStagedRun(request, { existsSync: exists })
    ).rejects.toThrow("not a real directory");
    expect(
      fs.readFileSync(path.join(target.radiusDir, "app.bicep"), "utf8")
    ).toContain("original");
  });

  it("rejects a destination changed to a directory during preflight", async () => {
    const target = fixture();
    const request = target.start();
    const destination = path.join(target.radiusDir, "app.bicep");
    const exists = vi.fn(fs.existsSync).mockImplementation((file) => {
      if (
        String(file) ===
        path.join(request.stagingDir, "app.bicep.published-backup")
      ) {
        fs.rmSync(destination);
        fs.mkdirSync(destination);
      }
      return fs.existsSync(file);
    });
    await expect(
      promotion.promoteStagedRun(request, { existsSync: exists })
    ).rejects.toThrow("not a regular file");
    expect(fs.statSync(destination).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(target.radiusDir, "app.origin.json"))).toBe(
      false
    );
  });

  it("handles a radius directory removed before the staging sweep", () => {
    const target = fixture();
    let removed = false;
    const exists = vi.fn(fs.existsSync).mockImplementation((file) => {
      if (
        !removed &&
        String(file) === target.radiusDir &&
        fs.existsSync(file)
      ) {
        removed = true;
        fs.rmSync(target.radiusDir, { recursive: true, force: true });
      }
      return fs.existsSync(file);
    });
    const stagingDir = promotion.beginStagedRun(
      { radiusDir: target.radiusDir },
      { existsSync: exists }
    );
    expect(fs.existsSync(path.join(stagingDir, "run.json"))).toBe(true);
  });

  it("handles a filesystem-root path without inventing an empty filename component", () => {
    const mkdir = vi.fn<typeof fs.mkdirSync>(() => {
      throw new Error("root is not writable");
    });
    expect(() =>
      promotion.beginStagedRun(
        { radiusDir: path.parse(process.cwd()).root },
        { mkdirSync: mkdir }
      )
    ).toThrow("root is not writable");
    expect(mkdir).toHaveBeenCalledOnce();
  });

  it("sanitizes a non-string JavaScript run identifier like the core rule", () => {
    const target = fixture();
    const stagingDir = Reflect.apply(promotion.beginStagedRun, undefined, [
      { radiusDir: target.radiusDir, runId: 42 }
    ]);
    expect(path.basename(stagingDir)).toBe(".staging-run");
  });

  it.each(["ENOENT", "EACCES"])(
    "handles a staging sweep stat failure %s without deleting a live run",
    (code) => {
      const target = fixture();
      const request = target.start();
      const stat = (file: fs.PathLike) => {
        if (String(file) === request.stagingDir) {
          if (code === "ENOENT")
            fs.rmSync(request.stagingDir, { recursive: true, force: true });
          throw Object.assign(new Error("cannot inspect staged run"), { code });
        }
        return fs.lstatSync(file);
      };
      const begin = () =>
        promotion.beginStagedRun(
          { radiusDir: target.radiusDir, runId: "next", staleAfterMs: 0 },
          { lstatSync: stat }
        );
      if (code === "ENOENT") expect(fs.existsSync(begin())).toBe(true);
      else {
        expect(begin).toThrow("cannot inspect staged run");
        expect(fs.existsSync(path.join(request.stagingDir, "run.json"))).toBe(
          true
        );
      }
    }
  );

  it("does not overwrite a concurrent edit when the staged rename fails after creating the backup", async () => {
    const target = fixture();
    const request = target.start();
    const destination = path.join(target.radiusDir, "app.bicep");
    await expect(
      promotion.promoteStagedRun(request, {
        renameSync(from, to) {
          if (String(from) === path.join(request.stagingDir, "app.bicep")) {
            fs.writeFileSync(to, "concurrent work");
            throw new Error("replacement lost the race");
          }
          fs.renameSync(from, to);
        }
      })
    ).rejects.toMatchObject({
      code: "PROMOTION_ROLLBACK_FAILED",
      rollback: "failed"
    });
    expect(fs.readFileSync(destination, "utf8")).toBe("concurrent work");
    expect(
      fs.readFileSync(
        path.join(request.stagingDir, "app.bicep.published-backup"),
        "utf8"
      )
    ).toContain("original");
  });

  it("preserves recovery data that appears after preflight", async () => {
    const target = fixture();
    const request = target.start();
    const backup = path.join(request.stagingDir, "app.bicep.published-backup");
    request.checkInputs = async (published) => {
      if (published) fs.writeFileSync(backup, "recovery bytes");
    };
    await expect(promotion.promoteStagedRun(request)).rejects.toMatchObject({
      retainStaging: true
    });
    expect(fs.readFileSync(backup, "utf8")).toBe("recovery bytes");
    expect(
      fs.readFileSync(path.join(target.radiusDir, "app.bicep"), "utf8")
    ).toContain("original");
  });

  it.each([
    "../outside",
    "..",
    "C:/outside",
    "C:outside",
    "folder\\input",
    "folder:input"
  ])(
    "rejects unsafe recorded input paths even when their fingerprints are present: %s",
    async (file) => {
      const target = fixture();
      const request = target.start();
      request.record = readRecord(request);
      request.record.inputFiles.push(file);
      request.record.sourceBaseline[file] = null;
      await expect(promotion.promoteStagedRun(request)).rejects.toThrow(
        `Unsafe effective input path: ${file}`
      );
      expect(
        fs.readFileSync(path.join(target.radiusDir, "app.bicep"), "utf8")
      ).toContain("original");
    }
  );
});
