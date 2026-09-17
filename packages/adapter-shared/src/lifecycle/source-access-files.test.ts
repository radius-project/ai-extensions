import { mkdir, writeFile, rm, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalSourceRoot,
  nodeSourceFileSystem,
  readSourceFile,
  writeSourceFile,
  SourceAccessFault,
  type SourceFileSystem
} from "./source-access-files.js";

let fixture: string;
let root: string;
beforeEach(async () => {
  fixture = join(process.cwd(), ".artifacts", `source-files-${randomUUID()}`);
  root = join(fixture, "workspace");
  await mkdir(root, { recursive: true });
});
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

const active = { aborted: false };
const read = (
  path: string,
  files: SourceFileSystem = nodeSourceFileSystem,
  maxBytes = 1_000_000
) => readSourceFile(files, root, path, maxBytes, active);

describe("confined source file capture", () => {
  it("rejects relative roots and Git metadata", async () => {
    await expect(
      canonicalSourceRoot(nodeSourceFileSystem, "relative")
    ).rejects.toMatchObject({
      result: { error: { code: "PRECONDITION_FAILED" } }
    });
    await expect(read(".git/config")).rejects.toMatchObject({
      result: { status: "forbidden" }
    });
  });

  it.each([true, false])(
    "preserves inspection errors with an omitted name: %s",
    async (omit) => {
      await writeFile(join(root, "data"), "data");
      const failure = Object.assign(new Error("inspection denied"), {
        code: "EACCES"
      });
      const files: SourceFileSystem = {
        ...nodeSourceFileSystem,
        readdir: async () => (omit ? [] : ["data"]),
        lstat: async () => {
          throw failure;
        }
      };
      await expect(read("data", files)).rejects.toBe(failure);
    }
  );

  it.each(["removed", "replaced"])(
    "detects a file %s after final handle inspection",
    async (change) => {
      await writeFile(join(root, "data"), "original");
      const files: SourceFileSystem = {
        ...nodeSourceFileSystem,
        open: async (path) => {
          const handle = await nodeSourceFileSystem.open(path);
          let calls = 0;
          return {
            ...handle,
            stat: async () => {
              const result = await handle.stat();
              if (++calls === 2) {
                await rm(path);
                if (change === "replaced") await writeFile(path, "replacement");
              }
              return result;
            }
          };
        }
      };
      await expect(read("data", files)).rejects.toMatchObject({
        result: { error: { code: "SOURCE_CHANGED" } }
      });
    }
  );

  it("reuses ordinary output directories but rejects linked and file parents", async () => {
    await mkdir(join(root, "folder"));
    await writeSourceFile(
      nodeSourceFileSystem,
      root,
      "folder/data",
      Buffer.from("data")
    );
    const outside = join(fixture, "outside");
    await mkdir(outside);
    await symlink(
      outside,
      join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir"
    );
    await writeFile(join(root, "file-parent"), "file");
    for (const path of ["linked/data", "file-parent/data"]) {
      await expect(
        writeSourceFile(nodeSourceFileSystem, root, path, Buffer.from("data"))
      ).rejects.toMatchObject({ result: { status: "forbidden" } });
    }
    const failure = new Error("mkdir unavailable");
    await expect(
      writeSourceFile(
        {
          ...nodeSourceFileSystem,
          mkdir: async () => {
            throw failure;
          }
        },
        root,
        "new/data",
        Buffer.from("data")
      )
    ).rejects.toBe(failure);
  });

  it.each(["", ".", "..", "../outside", "/outside", "C:\\outside"])(
    "rejects unsafe snapshot output %j without walking outside the root",
    async (path) => {
      await expect(
        writeSourceFile(nodeSourceFileSystem, root, path, Buffer.from("data"))
      ).rejects.toMatchObject({ result: { status: "forbidden" } });
    }
  );
  it("reads exact bytes, including empty and binary files, and reports confirmed absence", async () => {
    await writeFile(join(root, "app.bicep"), Buffer.from([0, 255, 13, 10]));
    await writeFile(join(root, "empty"), "");
    expect(await canonicalSourceRoot(nodeSourceFileSystem, root)).toBe(
      await nodeSourceFileSystem.realpath(root)
    );
    expect(await read("app.bicep")).toMatchObject({
      status: "present",
      bytes: Buffer.from([0, 255, 13, 10])
    });
    expect(await read("empty")).toMatchObject({
      status: "present",
      bytes: Buffer.alloc(0)
    });
    expect(await read("missing/child")).toEqual({ status: "absent" });
  });

  it("reads files larger than one bounded read chunk", async () => {
    const bytes = Buffer.alloc(70_000, 7);
    await writeFile(join(root, "large"), bytes);
    expect(await read("large")).toMatchObject({ status: "present", bytes });
  });

  it.each([
    "../outside",
    "/outside",
    "C:\\outside",
    "\\\\server\\share",
    "file\n",
    "NUL"
  ])("rejects unsafe path %j before filesystem access", async (path) => {
    await expect(read(path)).rejects.toMatchObject({
      result: { status: "failed", error: { code: "INVALID_REQUEST" } }
    });
  });

  it("rejects links/junctions that escape the root without reading outside bytes", async () => {
    const outside = join(fixture, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "data"), "outside");
    await symlink(
      outside,
      join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir"
    );
    await expect(read("linked/data")).rejects.toMatchObject({
      result: { status: "forbidden" }
    });
  });

  it("rejects internal links/junction aliases and hard-linked files", async () => {
    const inside = join(root, "inside");
    await mkdir(inside);
    await writeFile(join(inside, "data"), "inside");
    await symlink(
      inside,
      join(root, "alias"),
      process.platform === "win32" ? "junction" : "dir"
    );
    await expect(read("alias/data")).rejects.toMatchObject({
      result: { status: "forbidden" }
    });
    await link(join(inside, "data"), join(root, "hardlink"));
    await expect(read("hardlink")).rejects.toMatchObject({
      result: { status: "forbidden" }
    });
  });

  it("rejects case aliases and non-file/non-directory input boundaries", async () => {
    await writeFile(join(root, "app.bicep"), "data");
    await mkdir(join(root, "directory"));
    await expect(read("APP.BICEP")).rejects.toMatchObject({
      result: { status: "failed", error: { code: "INVALID_REQUEST" } }
    });
    await expect(read("directory")).rejects.toMatchObject({
      result: { status: "failed", error: { code: "INVALID_REQUEST" } }
    });
    await expect(read("app.bicep/child")).rejects.toMatchObject({
      result: { status: "failed", error: { code: "INVALID_REQUEST" } }
    });
    await expect(
      canonicalSourceRoot(nodeSourceFileSystem, join(root, "app.bicep"))
    ).rejects.toMatchObject({
      result: { status: "failed", error: { code: "PRECONDITION_FAILED" } }
    });
  });

  it("fails closed on directory enumeration failures and names that resolve through aliases", async () => {
    await writeFile(join(root, "app.bicep"), "data");
    const omittedName: SourceFileSystem = {
      ...nodeSourceFileSystem,
      readdir: async () => []
    };
    await expect(read("app.bicep", omittedName)).rejects.toMatchObject({
      result: { error: { code: "INVALID_REQUEST" } }
    });
    const unavailable: SourceFileSystem = {
      ...nodeSourceFileSystem,
      readdir: async () => {
        throw new Error("unavailable");
      }
    };
    await expect(read("app.bicep", unavailable)).rejects.toThrow("unavailable");
    const collisions: SourceFileSystem = {
      ...nodeSourceFileSystem,
      readdir: async () => ["app.bicep", "APP.BICEP"]
    };
    await expect(read("app.bicep", collisions)).rejects.toMatchObject({
      result: { error: { code: "INVALID_REQUEST" } }
    });
  });

  it("rejects a changed or escaped resolved path before opening a file", async () => {
    await writeFile(join(root, "app.bicep"), "data");
    const escaped: SourceFileSystem = {
      ...nodeSourceFileSystem,
      realpath: async () => join(fixture, "outside")
    };
    await expect(read("app.bicep", escaped)).rejects.toMatchObject({
      result: { status: "forbidden" }
    });
  });

  it("detects input removal after enumeration", async () => {
    await writeFile(join(root, "app.bicep"), "data");
    const files: SourceFileSystem = {
      ...nodeSourceFileSystem,
      readdir: async (directory) => {
        const names = await nodeSourceFileSystem.readdir(directory);
        await rm(join(root, "app.bicep"));
        return names;
      }
    };
    await expect(read("app.bicep", files)).rejects.toMatchObject({
      result: { error: { code: "SOURCE_CHANGED" } }
    });
  });

  it("checks limits before reading and when a file grows during a bounded read", async () => {
    await writeFile(join(root, "data"), "12345");
    await expect(read("data", nodeSourceFileSystem, 4)).rejects.toMatchObject({
      result: { error: { code: "VALIDATION_INCOMPLETE" } }
    });
    const growing: SourceFileSystem = {
      ...nodeSourceFileSystem,
      open: async (path) => {
        const handle = await nodeSourceFileSystem.open(path);
        return {
          ...handle,
          read: async (offset, length) => {
            await writeFile(path, "123456");
            return handle.read(offset, length);
          }
        };
      }
    };
    await expect(read("data", growing, 5)).rejects.toMatchObject({
      result: { error: { code: "SOURCE_CHANGED" } }
    });
  });

  it("detects source replacement at open and edits after reading, and closes acquired handles", async () => {
    await writeFile(join(root, "data"), "old");
    let closed = 0;
    const changedAtOpen: SourceFileSystem = {
      ...nodeSourceFileSystem,
      open: async (path) => {
        await writeFile(path, "replacement bytes");
        const handle = await nodeSourceFileSystem.open(path);
        return {
          ...handle,
          close: async () => {
            await handle.close();
            closed++;
          }
        };
      }
    };
    await expect(read("data", changedAtOpen)).rejects.toMatchObject({
      result: { error: { code: "SOURCE_CHANGED" } }
    });
    expect(closed).toBe(1);
    let changed = false;
    const changedAfterRead: SourceFileSystem = {
      ...nodeSourceFileSystem,
      open: async (path) => {
        const handle = await nodeSourceFileSystem.open(path);
        return {
          ...handle,
          read: async (offset, length) => {
            const bytes = await handle.read(offset, length);
            if (!changed) {
              changed = true;
              await writeFile(path, "newer");
            }
            return bytes;
          }
        };
      }
    };
    await expect(read("data", changedAfterRead)).rejects.toMatchObject({
      result: { error: { code: "SOURCE_CHANGED" } }
    });
  });

  it("handles cancellation before open and during reading with cleanup", async () => {
    await writeFile(join(root, "data"), "text");
    await expect(
      readSourceFile(nodeSourceFileSystem, root, "data", 100, { aborted: true })
    ).rejects.toMatchObject({ result: { status: "cancelled" } });
    const signal = { aborted: false };
    let closed = false;
    const files: SourceFileSystem = {
      ...nodeSourceFileSystem,
      open: async (path) => {
        const handle = await nodeSourceFileSystem.open(path);
        return {
          ...handle,
          read: async (offset, length) => {
            const bytes = await handle.read(offset, length);
            signal.aborted = true;
            return bytes;
          },
          close: async () => {
            await handle.close();
            closed = true;
          }
        };
      }
    };
    await expect(
      readSourceFile(files, root, "data", 100, signal)
    ).rejects.toMatchObject({ result: { status: "cancelled" } });
    expect(closed).toBe(true);
  });

  it("reports close failures without losing an existing source-change failure", async () => {
    await writeFile(join(root, "data"), "text");
    for (const changed of [false, true]) {
      const files: SourceFileSystem = {
        ...nodeSourceFileSystem,
        open: async (path) => {
          if (changed) await writeFile(path, "changed length");
          const handle = await nodeSourceFileSystem.open(path);
          return {
            ...handle,
            close: async () => {
              await handle.close();
              throw new Error("raw close error");
            }
          };
        }
      };
      await expect(read("data", files)).rejects.toMatchObject({
        result: {
          status: "failed",
          error: { code: changed ? "SOURCE_CHANGED" : "PRECONDITION_FAILED" }
        }
      });
    }
  });

  it("does not expose raw failures in its classified fault message", () => {
    const fault = new SourceAccessFault({
      status: "cancelled",
      reason: "request_cancelled"
    });
    expect(fault.message).toBe("Source access stopped.");
  });
});
