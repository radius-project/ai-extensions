import { createHash } from "node:crypto";
import { join, posix } from "node:path";
import { CUSTOM_TYPE_STAGED_FILES } from "@radius-project/core/modeling";
import {
  portFailure,
  validateSourcePath,
  type DefinitionInput,
  type SourcePolicyCancellation
} from "@radius-project/core/lifecycle";
import {
  checkSourceCancellation,
  readSourceFile,
  SourceAccessFault,
  type SourceFileSystem
} from "./source-access-files.js";

interface InputReference {
  readonly path: string;
  readonly kind: "module" | "file" | "custom-type";
}
export interface InputScan {
  readonly complete: boolean;
  readonly references: readonly InputReference[];
}
interface Token {
  kind: "identifier" | "string" | "symbol";
  value: string;
  multiline?: boolean;
  dynamic?: boolean;
  declaration?: boolean;
}

function tokens(text: string): { values: Token[]; complete: boolean } {
  const values: Token[] = [];
  let index = 0;
  function scan(interpolation = false): boolean {
    let depth = 0;
    let lineStart = true;
    while (index < text.length) {
      const rest = text.slice(index);
      const space = /^\s+/.exec(rest);
      if (space) {
        if (/[\r\n]/.test(space[0])) lineStart = true;
        index += space[0].length;
        continue;
      }
      if (rest.startsWith("//")) {
        const end = rest.search(/[\r\n]/);
        index = end < 0 ? text.length : index + end + 1;
        lineStart = true;
        continue;
      }
      if (rest.startsWith("/*")) {
        const end = text.indexOf("*/", index + 2);
        if (end < 0) return false;
        if (/[\r\n]/.test(text.slice(index, end))) lineStart = true;
        index = end + 2;
        continue;
      }
      const declaration = !interpolation && depth === 0 && lineStart;
      lineStart = false;
      if (rest.startsWith("'''")) {
        const end = text.indexOf("'''", index + 3);
        if (end < 0) return false;
        values.push({
          kind: "string",
          value: text.slice(index + 3, end),
          multiline: true
        });
        index = end + 3;
        continue;
      }
      if (rest.startsWith("'")) {
        index++;
        const literal: Token = { kind: "string", value: "" };
        values.push(literal);
        let closed = false;
        while (index < text.length) {
          const character = text[index++];
          if (character === "'") {
            closed = true;
            break;
          }
          if (character === "$" && text[index] === "{") {
            literal.dynamic = true;
            index++;
            // Expressions remain syntax: a load call inside interpolation still
            // contributes an input, while the surrounding text never does.
            if (!scan(true)) return false;
            continue;
          }
          if (character === "\\") {
            const escaped = text[index++];
            const escapes: Record<string, string> = {
              "'": "'",
              "\\": "\\",
              n: "\n",
              r: "\r",
              t: "\t",
              $: "$"
            };
            if (escaped === "u") {
              const unicode = /^\{([0-9a-fA-F]{1,6})\}/.exec(text.slice(index));
              if (!unicode || Number.parseInt(unicode[1], 16) > 0x10ffff)
                return false;
              literal.value += String.fromCodePoint(
                Number.parseInt(unicode[1], 16)
              );
              index += unicode[0].length;
            } else {
              if (!Object.hasOwn(escapes, escaped)) return false;
              literal.value += escapes[escaped];
            }
          } else literal.value += character;
        }
        if (!closed) return false;
        continue;
      }
      const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
      if (identifier) {
        values.push({ kind: "identifier", value: identifier[0], declaration });
        index += identifier[0].length;
      } else {
        const value = text[index++];
        if (value === "}" && interpolation && depth === 0) return true;
        if (["{", "(", "["].includes(value)) depth++;
        if (["}", ")", "]"].includes(value)) depth--;
        values.push({ kind: "symbol", value });
      }
    }
    return !interpolation && depth === 0;
  }
  const complete = scan();
  return { values, complete };
}

export function scanBicepInputs(
  text: string,
  availableExtensions: readonly string[] = [],
  mode: "capture" | "compilation" = "capture"
): InputScan {
  const parsed = tokens(text);
  const references: InputReference[] = [];
  let complete = parsed.complete;
  for (const [index, token] of parsed.values.entries()) {
    if (token.kind !== "identifier") continue;
    if (token.value === "extension" && token.declaration) {
      const extension = parsed.values[index + 1];
      if (extension?.kind === "identifier") {
        if (!availableExtensions.includes(extension.value)) complete = false;
      } else if (
        extension?.kind === "string" &&
        !extension.multiline &&
        !extension.dynamic
      ) {
        if (
          mode === "compilation" &&
          /^(?:br[:/]|ts[:/])/.test(extension.value)
        )
          complete = false;
        else if (!extension.value.startsWith("br:"))
          references.push({ path: extension.value, kind: "custom-type" });
      } else complete = false;
      continue;
    }
    if (
      ((token.value === "import" || token.value === "using") &&
        token.declaration) ||
      (token.value === "loadDirectoryFileInfo" &&
        parsed.values[index + 1]?.value === "(")
    )
      complete = false;
    const module = token.value === "module" && token.declaration;
    const load =
      [
        "loadTextContent",
        "loadJsonContent",
        "loadYamlContent",
        "loadFileAsBase64"
      ].includes(token.value) && parsed.values[index + 1]?.value === "(";
    if (!module && !load) continue;
    const candidate = parsed.values[index + 2];
    const next = parsed.values[index + 3]?.value;
    if (
      candidate?.kind !== "string" ||
      candidate.multiline ||
      candidate.dynamic ||
      (module && parsed.values[index + 1]?.kind !== "identifier") ||
      (module ? next !== "=" : next !== "," && next !== ")")
    ) {
      complete = false;
      continue;
    }
    if (/^(?:br:|br\/|ts:|ts\/)/.test(candidate.value)) {
      complete = false;
      continue;
    }
    references.push({
      path: candidate.value,
      kind: module ? "module" : "file"
    });
  }
  return { complete, references };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export interface ConfigurationInputScan extends InputScan {
  readonly extensions: readonly string[];
}
export function scanConfigurationInputs(
  text: string,
  mode: "capture" | "compilation" = "capture"
): ConfigurationInputScan {
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    return { complete: false, references: [], extensions: [] };
  }
  if (!object(config))
    return { complete: false, references: [], extensions: [] };
  if (config.extensions === undefined)
    return { complete: true, references: [], extensions: [] };
  if (!object(config.extensions))
    return { complete: false, references: [], extensions: [] };
  const references: InputReference[] = [];
  const extensions: string[] = [];
  let complete = true;
  for (const [name, value] of Object.entries(config.extensions)) {
    if (
      mode === "compilation" &&
      typeof value === "string" &&
      /^(?:br[:/]|ts[:/])/.test(value)
    )
      continue;
    extensions.push(name);
    if (typeof value !== "string" || value.length === 0) {
      complete = false;
      continue;
    }
    if (value.startsWith("br:")) continue;
    if (value.includes(":") && !/^[A-Za-z]:/.test(value)) {
      complete = false;
      continue;
    }
    references.push({ path: value, kind: "custom-type" });
  }
  return { complete, references, extensions };
}

export function resolveInputReference(
  issuer: string,
  reference: string
): string {
  if (/^[\\/]|[\\:%\u0000-\u001f\u007f]/u.test(reference))
    throw new SourceAccessFault(portFailure("INVALID_REQUEST"));
  const path = posix.normalize(posix.join(posix.dirname(issuer), reference));
  if (validateSourcePath(path).status !== "ok")
    throw new SourceAccessFault(portFailure("INVALID_REQUEST"));
  return path;
}

export interface SourceCaptureLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}
export interface CollectedSourceInputs {
  readonly inputs: readonly DefinitionInput[];
  readonly bytes: ReadonlyMap<string, Uint8Array>;
  readonly complete: boolean;
  readonly definitionPresent: boolean;
}
const rank: Record<DefinitionInput["kind"], number> = {
  file: 0,
  module: 1,
  recipe: 2,
  "custom-type": 3,
  configuration: 4,
  definition: 5
};
export async function collectSourceInputs(
  files: SourceFileSystem,
  root: string,
  definition: string,
  limits: SourceCaptureLimits,
  signal: SourcePolicyCancellation,
  mode: "capture" | "compilation" = "capture",
  expectedDefinitionAbsence = false
): Promise<CollectedSourceInputs> {
  const inputs = new Map<string, DefinitionInput>();
  const bytes = new Map<string, Uint8Array>();
  const parsed = new Set<string>();
  const configurations = new Map<string, readonly string[]>();
  let complete = true;
  let total = 0;

  async function capture(
    path: string,
    kind: DefinitionInput["kind"]
  ): Promise<Uint8Array | undefined> {
    checkSourceCancellation(signal);
    const existing = inputs.get(path);
    if (existing) {
      if (rank[kind] > rank[existing.kind]) existing.kind = kind;
      return bytes.get(path);
    }
    if (inputs.size >= limits.maxFiles) {
      complete = false;
      return undefined;
    }
    const file = await readSourceFile(
      files,
      root,
      path,
      limits.maxFileBytes,
      signal
    );
    const present = file.status === "present";
    const content = present ? file.bytes : undefined;
    inputs.set(path, {
      path,
      kind,
      existed: present,
      contentHash:
        content === undefined ? null : (
          `sha256:${createHash("sha256").update(content).digest("hex")}`
        )
    });
    if (content !== undefined) {
      total += content.byteLength;
      if (total > limits.maxTotalBytes) {
        complete = false;
        return undefined;
      }
      bytes.set(path, content);
    }
    return content;
  }
  function text(content: Uint8Array): string | undefined {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      complete = false;
      return undefined;
    }
  }
  const artifacts = new Set<string>();
  async function customType(path: string): Promise<void> {
    if ((await capture(path, "custom-type")) === undefined) {
      complete = false;
      return;
    }
    if (artifacts.has(path)) return;
    artifacts.add(path);
    if (
      mode === "compilation" ||
      posix.basename(path) !== CUSTOM_TYPE_STAGED_FILES[1]
    ) {
      // Bicep's local ExtensionV1Archive consumes this one binary file; its
      // types and optional binaries are archive members, not sibling inputs.
      // Package validity is the compiler's job, not source-closure discovery.
      if (!path.endsWith(".tgz")) complete = false;
      return;
    }
    const folder = posix.dirname(path);
    if (
      (await capture(
        posix.join(folder, CUSTOM_TYPE_STAGED_FILES[0]),
        "custom-type"
      )) === undefined
    )
      complete = false;
    await visit(posix.join(folder, "custom-recipe-pack.bicep"), "recipe");
    const names = await files.readdir(join(root, ...folder.split("/")));
    for (const name of names.filter((name) => name.endsWith("-recipe.bicep"))) {
      await visit(posix.join(folder, name), "recipe");
    }
  }
  async function configurationFor(source: string): Promise<readonly string[]> {
    let directory = posix.dirname(source);
    for (;;) {
      const configPath = posix.join(directory, "bicepconfig.json");
      const content = await capture(configPath, "configuration");
      if (content !== undefined) {
        if (!configurations.has(configPath)) {
          configurations.set(configPath, []);
          const decoded = text(content);
          if (decoded !== undefined) {
            const scan = scanConfigurationInputs(decoded, mode);
            configurations.set(configPath, scan.extensions);
            complete = complete && scan.complete;
            for (const reference of scan.references) {
              const path = resolveInputReference(configPath, reference.path);
              await customType(path);
            }
          }
        }
        return configurations.get(configPath) ?? [];
      }
      if (directory === ".") return [];
      directory = posix.dirname(directory);
    }
  }
  async function visit(
    path: string,
    kind: "definition" | "module" | "recipe"
  ): Promise<void> {
    const content = await capture(path, kind);
    if (content === undefined) {
      if (
        expectedDefinitionAbsence &&
        kind === "definition" &&
        inputs.get(path)?.existed === false
      ) {
        await configurationFor(path);
        return;
      }
      complete = false;
      return;
    }
    if (parsed.has(path)) return;
    parsed.add(path);
    if (!path.endsWith(".bicep")) {
      complete = false;
      return;
    }
    const extensions = await configurationFor(path);
    const decoded = text(content);
    if (decoded === undefined) return;
    const scan = scanBicepInputs(decoded, extensions, mode);
    complete = complete && scan.complete;
    for (const reference of scan.references) {
      const dependency = resolveInputReference(path, reference.path);
      if (reference.kind === "module") await visit(dependency, "module");
      else if (reference.kind === "custom-type") await customType(dependency);
      else if ((await capture(dependency, "file")) === undefined)
        complete = false;
    }
  }
  await visit(definition, "definition");
  return {
    inputs: [...inputs.values()],
    bytes,
    complete,
    definitionPresent: inputs.get(definition)?.existed === true
  };
}
