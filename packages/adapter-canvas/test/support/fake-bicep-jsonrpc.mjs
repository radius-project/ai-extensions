// Stands in for `bicep jsonrpc --stdio` in tests that run the application
// checker without the managed Bicep. The checker runs its stand-in Bicep as
// `<node> jsonrpc --stdio` from the model's directory, so a test installs a
// `jsonrpc` shim there that imports this module.
//
// Like the real server, it answers `bicep/getFileReferences` only while its
// input is open and exits once the input closes. By default it lists the model
// and, when anything exists at that path, the `bicepconfig.json` beside it —
// the files a single-file model in a fresh directory compiles with. A
// `jsonrpc.json` file in the same directory changes the behavior:
//
//   filePaths  list exactly these files instead
//   raw        write this text instead of a framed response
//   error      answer with this JSON-RPC error object
//   notify     send a notification frame before the response
//   stderr     write this text to stderr before answering or exiting
//   exitCode   exit with this status instead of answering
//   signal     end with this signal instead of answering
//   linger     keep running after the input closes, until killed
//   trailing   write this text once the input closes, after answering
//   exitAtStart  exit with this status before reading any input
//   awaitFile  answer only once this file exists in the directory
//   close      exit as soon as the answer is written, without waiting for input
//              to close
//   hang       never answer, and stay alive until killed

import fs from "node:fs";
import path from "node:path";

const controlFile = path.join(process.cwd(), "jsonrpc.json");
const control =
  fs.existsSync(controlFile) ?
    JSON.parse(fs.readFileSync(controlFile, "utf8"))
  : {};

function frame(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function defaultFilePaths(app) {
  const config = path.join(path.dirname(app), "bicepconfig.json");
  return exists(config) ? [app, config] : [app];
}

function write(text) {
  process.stdout.write(text, () => {
    if (control.close) process.exit(0);
  });
}

function respond(request) {
  if (
    control.awaitFile !== undefined &&
    !fs.existsSync(path.join(process.cwd(), control.awaitFile))
  ) {
    setTimeout(() => respond(request), 20);
    return;
  }
  if (control.signal !== undefined) {
    process.kill(process.pid, control.signal);
    return;
  }
  if (control.exitCode !== undefined) {
    process.stderr.write(control.stderr ?? "", () => {
      process.exit(control.exitCode);
    });
    return;
  }
  if (control.stderr !== undefined) process.stderr.write(control.stderr);
  if (control.raw !== undefined) {
    write(control.raw);
    return;
  }
  const notification =
    control.notify ?
      frame({ jsonrpc: "2.0", method: "window/logMessage", params: {} })
    : "";
  const answer =
    control.error !== undefined ?
      { jsonrpc: "2.0", id: request.id, error: control.error }
    : {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          filePaths: control.filePaths ?? defaultFilePaths(request.params.path)
        }
      };
  write(notification + frame(answer));
}

if (control.exitAtStart !== undefined) {
  process.exit(control.exitAtStart);
} else if (control.hang) {
  setInterval(() => {}, 60_000);
} else {
  let input = Buffer.alloc(0);
  let answered = false;
  process.stdin.on("data", (chunk) => {
    input = Buffer.concat([input, chunk]);
    const separator = input.indexOf("\r\n\r\n");
    if (answered || separator === -1) return;
    const length = Number(
      /Content-Length: (\d+)/u.exec(input.subarray(0, separator).toString())[1]
    );
    const body = input.subarray(separator + 4);
    if (body.length < length) return;
    answered = true;
    respond(JSON.parse(body.subarray(0, length).toString("utf8")));
  });
  process.stdin.on("end", () => {
    if (control.trailing !== undefined) {
      write(control.trailing);
      process.stdout.end(() => process.exit(0));
      return;
    }
    if (control.linger) {
      setInterval(() => {}, 60_000);
      return;
    }
    process.exit(0);
  });
}
