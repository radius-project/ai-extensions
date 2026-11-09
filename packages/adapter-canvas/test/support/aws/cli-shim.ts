import http from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

// Puts `aws` and `gh` first on PATH as small programs that forward each call
// to this test process over a loopback port. The production runtime then runs
// its real CLI calls, through its own spawn code, against the same in-process
// fakes the test drives. A handler that never answers holds the call open, as
// a process killed mid-call would leave it.

export interface CliAnswer {
  code: number | string;
  stdout: string;
  stderr: string;
}

export type CliHandler = (args: string[]) => Promise<CliAnswer>;

export interface CliShim {
  // Calls the handlers threw on, which the runtime saw as failed commands.
  readonly errors: string[];
  /**
   * Refuse every call from now on, including any held open, without reaching
   * the fakes. A crashed runtime that wakes up then fails fast instead of
   * changing what the next test sees.
   */
  refuseAll(): void;
  /** Resolves once no call has been open or arrived for `quietMs`. */
  quiet(quietMs?: number, timeoutMs?: number): Promise<void>;
  // Takes the programs off PATH. Call it only once the runtimes are quiet:
  // a call after this would reach a real `aws` or `gh`.
  restore(): Promise<void>;
}

const FORWARD = `const http = require("node:http");
const [tool, ...args] = process.argv.slice(2);
const request = http.request(
  process.env.RADIUS_TEST_CLI_URL,
  { method: "POST", headers: { "content-type": "application/json" } },
  (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => (body += chunk));
    response.on("end", () => {
      const answer = JSON.parse(body);
      process.stdout.write(answer.stdout);
      process.stderr.write(answer.stderr);
      process.exitCode = Number(answer.code);
    });
  }
);
request.on("error", (error) => {
  process.stderr.write("test cli shim: " + error.message + "\\n");
  process.exitCode = 3;
});
request.end(JSON.stringify({ tool, args }));
`;

export async function installCliShim(handlers: {
  aws: CliHandler;
  gh: CliHandler;
}): Promise<CliShim> {
  const errors: string[] = [];
  const sockets = new Set<Socket>();
  let refusing = false;
  let open = 0;
  let lastCall = Date.now();
  const server = http.createServer((request, response) => {
    let body = "";
    open += 1;
    lastCall = Date.now();
    response.on("close", () => {
      open -= 1;
      lastCall = Date.now();
    });
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { tool, args } = JSON.parse(body) as {
        tool: "aws" | "gh";
        args: string[];
      };
      if (refusing) {
        response.end(
          JSON.stringify({ code: 3, stdout: "", stderr: "The test is over." })
        );
        return;
      }
      handlers[tool](args).then(
        (answer) => response.end(JSON.stringify(answer)),
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          errors.push(`${tool} ${args.join(" ")}: ${message}`);
          response.end(
            JSON.stringify({ code: 3, stdout: "", stderr: message })
          );
        }
      );
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The test CLI shim has no port.");
  }
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), "radius-cli-shim-"));
  await fs.writeFile(path.join(bin, "forward.cjs"), FORWARD);
  for (const tool of ["aws", "gh"]) {
    await fs.writeFile(
      path.join(bin, tool),
      `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, "forward.cjs")}" ${tool} "$@"\n`
    );
    await fs.chmod(path.join(bin, tool), 0o755);
    await fs.writeFile(
      path.join(bin, `${tool}.cmd`),
      `@echo off\r\n"${process.execPath}" "%~dp0forward.cjs" ${tool} %*\r\n`
    );
  }
  const saved = {
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT,
    RADIUS_TEST_CLI_URL: process.env.RADIUS_TEST_CLI_URL
  };
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ""}`;
  process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  process.env.RADIUS_TEST_CLI_URL = `http://127.0.0.1:${address.port}/`;
  return {
    errors,
    refuseAll() {
      refusing = true;
      for (const socket of sockets) socket.destroy();
    },
    async quiet(quietMs = 300, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      while (open > 0 || Date.now() - lastCall < quietMs) {
        if (Date.now() > deadline) {
          throw new Error("The CLI shim never went quiet.");
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    async restore() {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      // A held call ends now, so the process that sent it can wind down.
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(bin, { recursive: true, force: true });
    }
  };
}
