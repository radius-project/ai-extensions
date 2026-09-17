import {
  open,
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  lifecycleError,
  portCancelled,
  portFailure,
  portForbidden,
  portUnavailable,
  validateSourcePath,
  type PortAbsent,
  type PortCancelled,
  type PortError,
  type SourcePolicyCancellation
} from "@radius-project/core/lifecycle";

export interface SourceReadHandle {
  stat(): Promise<Stats>;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}
export interface SourceFileSystem {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<Stats>;
  readdir(path: string): Promise<string[]>;
  open(path: string): Promise<SourceReadHandle>;
  mkdir(path: string): Promise<void>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}
export const nodeSourceFileSystem: SourceFileSystem = Object.freeze({
  realpath,
  lstat,
  readdir: (path) => readdir(path),
  open: async (path) => {
    const handle = await open(path, "r");
    return {
      stat: () => handle.stat(),
      read: async (offset, length) => {
        const bytes = Buffer.alloc(length);
        const result = await handle.read(bytes, 0, length, offset);
        return bytes.subarray(0, result.bytesRead);
      },
      close: () => handle.close()
    };
  },
  mkdir: async (path) => {
    await mkdir(path, { mode: 0o700 });
  },
  write: async (path, bytes) => {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  },
  remove: async (path) => {
    await rm(path, { recursive: true, force: true });
  }
} satisfies SourceFileSystem);

export class SourceAccessFault extends Error {
  constructor(readonly result: PortError | PortCancelled | PortAbsent) {
    super("Source access stopped.");
  }
}
export function sourceUnavailable(): PortError {
  return portUnavailable("SOURCE_UNAVAILABLE", {
    quality: "unknown",
    evidence: "source",
    completeness: "unavailable"
  });
}
export function sourceCleanupFailure<T extends PortError>(primary: T): T {
  return {
    ...primary,
    error: {
      ...primary.error,
      details: lifecycleError(primary.error.code, {
        diagnostics: [
          { message: "Source cleanup did not complete.", truncated: false },
          ...(primary.error.details ?? [])
        ]
      }).details
    }
  };
}
export function checkSourceCancellation(
  signal: SourcePolicyCancellation
): void {
  if (signal.aborted)
    throw new SourceAccessFault(portCancelled("request_cancelled"));
}
function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
export function confined(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child !== ".." &&
    !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(child)
  );
}
export async function canonicalSourceRoot(
  files: SourceFileSystem,
  root: string
): Promise<string> {
  if (!isAbsolute(root))
    throw new SourceAccessFault(portFailure("PRECONDITION_FAILED"));
  const canonical = await files.realpath(root);
  if (!(await files.lstat(canonical)).isDirectory())
    throw new SourceAccessFault(portFailure("PRECONDITION_FAILED"));
  return canonical;
}
export type CapturedSourceFile =
  | { readonly status: "present"; readonly bytes: Uint8Array }
  | { readonly status: "absent" };

async function locateFile(
  files: SourceFileSystem,
  root: string,
  path: string
): Promise<{ path: string; stat: Stats } | undefined> {
  let current = root;
  const segments = path.split("/");
  for (const [index, segment] of segments.entries()) {
    const names = await files.readdir(current);
    const aliases = names.filter(
      (name) =>
        name.normalize("NFC").toLowerCase() ===
        segment.normalize("NFC").toLowerCase()
    );
    const candidate = join(current, segment);
    if (
      aliases.length > 1 ||
      (aliases.length === 1 && aliases[0] !== segment)
    ) {
      throw new SourceAccessFault(portFailure("INVALID_REQUEST"));
    }
    if (!names.includes(segment)) {
      try {
        await files.lstat(candidate);
      } catch (error) {
        if (hasCode(error, "ENOENT")) return undefined;
        throw error;
      }
      throw new SourceAccessFault(portFailure("INVALID_REQUEST"));
    }
    let stat: Stats;
    try {
      stat = await files.lstat(candidate);
    } catch (error) {
      if (hasCode(error, "ENOENT"))
        throw new SourceAccessFault(portFailure("SOURCE_CHANGED"));
      throw error;
    }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
      throw new SourceAccessFault(portForbidden());
    const actual = await files.realpath(candidate);
    if (!confined(root, actual) || actual !== candidate)
      throw new SourceAccessFault(portForbidden());
    if (index === segments.length - 1) {
      if (!stat.isFile())
        throw new SourceAccessFault(portFailure("INVALID_REQUEST"));
      return { path: candidate, stat };
    }
    if (!stat.isDirectory())
      throw new SourceAccessFault(portFailure("INVALID_REQUEST"));
    current = candidate;
  }
  return undefined;
}
function sameFile(before: Stats, after: Stats): boolean {
  // ctime includes metadata-only updates (including Windows file hydration);
  // content hashes across both capture passes are the source-byte authority.
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    after.nlink === 1 &&
    after.isFile()
  );
}
async function readHandle(
  files: SourceFileSystem,
  root: string,
  path: string,
  before: Stats,
  handle: SourceReadHandle,
  maxBytes: number,
  signal: SourcePolicyCancellation
): Promise<Uint8Array> {
  if (!sameFile(before, await handle.stat()))
    throw new SourceAccessFault(portFailure("SOURCE_CHANGED"));
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length <= maxBytes) {
    checkSourceCancellation(signal);
    const chunk = await handle.read(
      length,
      Math.min(65_536, maxBytes + 1 - length)
    );
    if (chunk.length === 0) break;
    chunks.push(chunk);
    length += chunk.length;
  }
  checkSourceCancellation(signal);
  if (length > maxBytes || !sameFile(before, await handle.stat()))
    throw new SourceAccessFault(portFailure("SOURCE_CHANGED"));
  const after = await locateFile(files, root, path);
  if (!after || !sameFile(before, after.stat))
    throw new SourceAccessFault(portFailure("SOURCE_CHANGED"));
  return Buffer.concat(chunks);
}
export async function readSourceFile(
  files: SourceFileSystem,
  root: string,
  path: string,
  maxBytes: number,
  signal: SourcePolicyCancellation
): Promise<CapturedSourceFile> {
  checkSourceCancellation(signal);
  const safe = validateSourcePath(path);
  if (safe.status !== "ok")
    throw new SourceAccessFault(portFailure("INVALID_REQUEST"));
  if (path.split("/").some((segment) => segment.toLowerCase() === ".git"))
    throw new SourceAccessFault(portForbidden());
  const located = await locateFile(files, root, path);
  if (!located) return { status: "absent" };
  if (located.stat.size > maxBytes) {
    throw new SourceAccessFault(
      portUnavailable("VALIDATION_INCOMPLETE", {
        quality: "unknown",
        evidence: "source",
        completeness: "partial",
        limitation: "An effective input exceeds the configured capture limit."
      })
    );
  }
  checkSourceCancellation(signal);
  const handle = await files.open(located.path);
  const result = await readHandle(
    files,
    root,
    path,
    located.stat,
    handle,
    maxBytes,
    signal
  ).then(
    (bytes) => ({ ok: true, bytes }) as const,
    (error: unknown) => ({ ok: false, error }) as const
  );
  try {
    await handle.close();
  } catch {
    const primary =
      (
        !result.ok &&
        result.error instanceof SourceAccessFault &&
        "error" in result.error.result
      ) ?
        result.error.result
      : portFailure("PRECONDITION_FAILED");
    throw new SourceAccessFault(sourceCleanupFailure(primary));
  }
  if (!result.ok) throw result.error;
  return { status: "present", bytes: result.bytes };
}

export async function writeSourceFile(
  files: SourceFileSystem,
  root: string,
  path: string,
  bytes: Uint8Array
): Promise<void> {
  if (validateSourcePath(path).status !== "ok")
    throw new SourceAccessFault(portForbidden());
  const target = resolve(root, ...path.split("/"));
  if (!confined(root, target)) throw new SourceAccessFault(portForbidden());
  const parents: string[] = [];
  let parent = dirname(target);
  while (parent !== root) {
    parents.unshift(parent);
    parent = dirname(parent);
  }
  for (const directory of parents) {
    try {
      await files.mkdir(directory);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      if (
        !(await files.lstat(directory)).isDirectory() ||
        (await files.lstat(directory)).isSymbolicLink()
      ) {
        throw new SourceAccessFault(portForbidden());
      }
    }
  }
  await files.write(target, bytes);
}
