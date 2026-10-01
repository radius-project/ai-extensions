import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  containedPath,
  HEADLAMP_IMAGE
} from "./fixtures/headlamp/contracts.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    image: { type: "string", default: "radius-headlamp-qualification:0.45.0" },
    candidates: { type: "string" },
    output: { type: "string" },
    "audit-css": { type: "boolean", default: false },
    inside: { type: "boolean", default: false }
  }
});

if (values.inside) {
  const { qualifyHeadlamp } = await import("./fixtures/headlamp/qualify.mjs");
  await qualifyHeadlamp(root, values.candidates, values.output, {
    auditCss: values["audit-css"]
  });
} else {
  const output = containedPath(
    root,
    resolve(
      root,
      values.output ?? join(".artifacts", "headlamp", `run-${Date.now()}`)
    )
  );
  mkdirSync(output, { recursive: true });
  const input = join(output, "input");
  mkdirSync(input);
  const copy = (path) => {
    cpSync(join(root, path), join(input, path), {
      recursive: true,
      filter: (source) =>
        !["node_modules", ".git", "dist"].includes(source.split(/[\\/]/).at(-1))
    });
  };
  for (const file of readdirSync(root)) {
    if (
      /^tsconfig.*\.json$/.test(file) ||
      ["package.json", "LICENSE"].includes(file)
    )
      copy(file);
  }
  for (const directory of ["core", "graph-react"])
    copy(join("packages", directory));
  for (const file of readdirSync(join(root, "scripts"))) {
    if (file.endsWith(".mjs")) copy(join("scripts", file));
  }
  copy(join("scripts", "fixtures", "headlamp"));
  if (values.candidates) {
    const candidates = containedPath(root, resolve(root, values.candidates));
    assert.ok(
      existsSync(candidates),
      `Candidate directory does not exist: ${candidates}`
    );
    cpSync(candidates, join(input, ".artifacts", "headlamp-seeds"), {
      recursive: true
    });
  }
  const docker = (args) => {
    const result = spawnSync("docker", args, {
      encoding: "utf8",
      timeout: 900_000,
      maxBuffer: 24 * 1024 * 1024
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(
        `docker ${args[0]} failed (${result.status}):\n${result.stdout}\n${result.stderr}`
      );
    return result.stdout;
  };
  const inspected = JSON.parse(docker(["image", "inspect", values.image]))[0];
  writeFileSync(
    join(output, "image.json"),
    JSON.stringify(
      {
        qualificationImage: values.image,
        imageId: inspected.Id,
        architecture: inspected.Architecture,
        hostImage: HEADLAMP_IMAGE
      },
      null,
      2
    )
  );
  const name = `radius-headlamp-${randomUUID()}`;
  let created = false;
  try {
    docker([
      "create",
      "--name",
      name,
      "--network",
      "none",
      // Private shared memory for Chromium; the host IPC namespace would give
      // candidate package code a channel that --network none does not close.
      "--shm-size",
      "1g",
      "--mount",
      `type=bind,source=${output},target=/receipts`,
      values.image,
      "node",
      "scripts/test-headlamp.mjs",
      "--inside",
      "--output",
      "/receipts",
      ...(values["audit-css"] ? ["--audit-css"] : []),
      ...(values.candidates ?
        ["--candidates", "/workspace/.artifacts/headlamp-seeds"]
      : [])
    ]);
    created = true;
    const container = JSON.parse(docker(["inspect", name]))[0];
    assert.equal(container.HostConfig.NetworkMode, "none");
    assert.notEqual(container.HostConfig.IpcMode, "host");
    writeFileSync(
      join(output, "container.json"),
      JSON.stringify(
        {
          networkMode: container.HostConfig.NetworkMode,
          imageId: container.Image
        },
        null,
        2
      )
    );
    docker([
      "cp",
      `${input}${process.platform === "win32" ? "\\." : "/."}`,
      `${name}:/workspace`
    ]);
    const result = spawnSync("docker", ["start", "--attach", name], {
      encoding: "utf8",
      timeout: 900_000,
      maxBuffer: 24 * 1024 * 1024
    });
    writeFileSync(
      join(output, "qualification.log"),
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    );
    if (result.error) throw result.error;
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    assert.equal(
      result.status,
      0,
      `Headlamp qualification failed; receipts: ${output}`
    );
    console.log(
      `${values["audit-css"] ? "Headlamp CSS collision audit completed" : "Real Headlamp qualification passed"}; receipts: ${output}`
    );
  } finally {
    if (created) docker(["rm", "--force", name]);
    rmSync(input, { recursive: true, force: true });
  }
}
