import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { decodeText, parseBicepConfig } from "./bicep-security-rules.mjs";

export function repairFileFingerprint(root, file, files) {
  const name = path.relative(root, file);
  if (
    !name ||
    name === ".." ||
    name.startsWith(`..${path.sep}`) ||
    path.isAbsolute(name)
  )
    throw new Error(`Repair input is outside the workspace: ${file}`);
  let current = root;
  const parts = name.split(path.sep);
  for (let index = 0; index < parts.length; index++) {
    if (parts[index].toLowerCase() === ".git")
      throw new Error("Repair cannot use Git metadata as a model input.");
    current = path.join(current, parts[index]);
    const stat = files.lstatSync(current);
    if (
      stat.isSymbolicLink() ||
      (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())
    )
      throw new Error(
        `Repair input must be a regular file without symlinks or junctions: ${current}`
      );
  }
  const resolved = files.realpathSync(file);
  if (
    process.platform === "win32" ?
      resolved.toLowerCase() !== file.toLowerCase()
    : resolved !== file
  )
    throw new Error(`Repair input resolves through an indirect path: ${file}`);
  const stat = files.statSync(file);
  return {
    hash: createHash("sha256").update(files.readFileSync(file)).digest("hex"),
    dev: stat.dev,
    ino: stat.ino
  };
}

// getFileReferences omits ARM-template imports and extension packages. Read
// artifact declarations, not arbitrary string literals, to complete that set.
export function artifactDeclarations(source) {
  let index = 0;
  const tokens = [];
  function quoted() {
    if (source.startsWith("'''", index)) {
      const end = source.indexOf("'''", index + 3);
      if (end === -1) throw new Error("Unterminated multiline Bicep string.");
      const value = source.slice(index + 3, end);
      index = end + 3;
      return { kind: "string", value };
    }
    index++;
    let value = "";
    let interpolated = false;
    while (index < source.length) {
      const char = source[index++];
      if (char === "'")
        return { kind: interpolated ? "expression" : "string", value };
      if (char === "\\") {
        const escaped = source[index++];
        const simple = {
          n: "\n",
          r: "\r",
          t: "\t",
          "\\": "\\",
          "'": "'",
          $: "$"
        };
        if (escaped === "u") {
          const match = /^\{([0-9a-fA-F]{1,6})\}/u.exec(source.slice(index));
          if (!match) throw new Error("Invalid Bicep Unicode escape.");
          value += String.fromCodePoint(Number.parseInt(match[1], 16));
          index += match[0].length;
        } else if (Object.hasOwn(simple, escaped)) value += simple[escaped];
        else throw new Error("Invalid Bicep string escape.");
      } else if (char === "$" && source[index] === "{") {
        index++;
        interpolated = true;
        scan("}");
      } else value += char;
    }
    throw new Error("Unterminated Bicep string.");
  }
  function scan(end = null, output = []) {
    while (index < source.length) {
      const char = source[index];
      if (end && char === end) {
        index++;
        return output;
      }
      if (source.startsWith("//", index)) {
        const newline = source.indexOf("\n", index + 2);
        index = newline === -1 ? source.length : newline;
      } else if (source.startsWith("/*", index)) {
        const close = source.indexOf("*/", index + 2);
        if (close === -1) throw new Error("Unterminated Bicep comment.");
        index = close + 2;
      } else if (char === "'") output.push(quoted());
      else if (char === "{" || char === "[" || char === "(") {
        index++;
        output.push({
          kind: "group",
          value: scan({ "{": "}", "[": "]", "(": ")" }[char])
        });
      } else if ("}])".includes(char))
        throw new Error("Unbalanced Bicep delimiters.");
      else if (/[A-Za-z_]/u.test(char)) {
        const start = index++;
        while (index < source.length && /[A-Za-z0-9_]/u.test(source[index]))
          index++;
        output.push({ kind: "identifier", value: source.slice(start, index) });
      } else {
        index++;
        if (!/\s/u.test(char)) output.push({ kind: "symbol", value: char });
        else if (char === "\n") output.push({ kind: "newline" });
      }
    }
    if (end) throw new Error("Unbalanced Bicep delimiters.");
    return output;
  }
  scan(null, tokens);
  const references = [];
  let statement = true;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "newline") {
      statement = true;
      continue;
    }
    if (!statement || token.kind !== "identifier") {
      statement = false;
      continue;
    }
    statement = false;
    const keyword = token.value;
    if (
      !["module", "import", "extension", "provider", "using"].includes(keyword)
    )
      continue;
    let next = i + 1;
    const take = () => {
      while (tokens[next]?.kind === "newline") next++;
      return tokens[next++];
    };
    let reference = take();
    if (keyword === "module") {
      if (reference?.kind !== "identifier")
        throw new Error("Cannot resolve malformed module declaration.");
      reference = take();
    } else if (keyword === "import") {
      if (reference?.kind === "group") reference = take();
      else if (reference?.value === "*") {
        if (take()?.value !== "as" || take()?.kind !== "identifier")
          throw new Error("Cannot resolve malformed wildcard import.");
        reference = take();
      }
      if (reference?.value !== "from")
        throw new Error("Cannot resolve malformed import declaration.");
      reference = take();
    }
    if (
      (keyword === "extension" || keyword === "provider") &&
      reference?.kind === "identifier"
    )
      references.push({ kind: "extension-alias", value: reference.value });
    else if (reference?.kind === "string")
      references.push({
        kind:
          keyword === "extension" || keyword === "provider" ?
            "extension"
          : "module",
        value: reference.value
      });
    else
      throw new Error(
        `Cannot resolve nonliteral ${keyword} artifact reference.`
      );
    i = next - 1;
  }
  return references;
}

function extensionCache(cacheRoot, reference) {
  const match =
    /^br:([^/]+)\/(.+?)(?::([^/:@]+)|@(sha256:[a-f0-9]{64}))$/u.exec(reference);
  if (!match)
    throw new Error(`Cannot resolve extension artifact: ${reference}`);
  const [, registry, repository, tag, digest] = match;
  if (
    repository.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Invalid extension repository.");
  let version = digest?.replace(":", "#");
  if (tag) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u.test(tag))
      throw new Error("Invalid extension tag.");
    let uppercase = 0n;
    for (let i = 0; i < tag.length; i++)
      if (/[A-Z]/u.test(tag[i])) uppercase |= 1n << BigInt(i);
    version = `${tag}$${uppercase ? uppercase.toString(16) : ""}`;
  }
  return path.join(
    cacheRoot,
    "br",
    registry.toLowerCase().replaceAll(":", "$"),
    repository.replaceAll("/", "$"),
    version
  );
}

// Paths outside the workspace are permitted only for the compiler's exact
// content-addressed/local or OCI extension artifact directory, never arbitrary
// model paths. These bytes are read-only and join the validation fingerprint.
export function supplementalRepairInputs(sourceFiles, root, files) {
  const inputs = new Map();
  const add = (file, boundary) => inputs.set(file, boundary);
  const pending = sourceFiles.filter((file) => /\.bicep$/iu.test(file));
  const visited = new Set();
  for (const source of pending) {
    if (visited.has(source)) continue;
    visited.add(source);
    let directory = path.dirname(source);
    let configPath;
    for (;;) {
      const candidate = path.join(directory, "bicepconfig.json");
      if (files.existsSync(candidate)) {
        configPath = candidate;
        break;
      }
      if (directory === path.dirname(directory)) break;
      directory = path.dirname(directory);
    }
    const parsed =
      configPath ?
        parseBicepConfig(decodeText(files.readFileSync(configPath)))
      : { config: {} };
    if (parsed.error)
      throw new Error(`Cannot resolve repair configuration: ${parsed.error}`);
    const config = parsed.config;
    if (
      config.cacheRootDirectory != null &&
      typeof config.cacheRootDirectory !== "string"
    )
      throw new Error("Invalid compiler cache directory.");
    let cacheRoot =
      config.cacheRootDirectory?.trim() ?
        config.cacheRootDirectory
      : path.join(os.homedir(), ".bicep");
    if (
      cacheRoot === "~" ||
      cacheRoot.startsWith("~/") ||
      cacheRoot.startsWith("~\\")
    )
      cacheRoot = os.homedir() + cacheRoot.slice(1);
    if (!path.isAbsolute(cacheRoot))
      throw new Error("Compiler cache directory must be absolute.");
    cacheRoot = path.resolve(cacheRoot);
    const implicit = config.implicitExtensions ?? ["az"];
    if (
      !Array.isArray(implicit) ||
      implicit.some((name) => typeof name !== "string" || !name)
    )
      throw new Error("Invalid implicit compiler extensions.");
    for (const declaration of [
      ...implicit.map((value) => ({ kind: "extension-implicit-alias", value })),
      ...artifactDeclarations(decodeText(files.readFileSync(source)))
    ]) {
      let reference = declaration.value;
      let relativeTo = path.dirname(source);
      const extension = declaration.kind.startsWith("extension");
      if (declaration.kind.endsWith("-alias")) {
        if (
          reference === "sys" ||
          (reference === "az" && config.extensions?.az === undefined) ||
          config.extensions?.[reference] === "builtin:"
        )
          continue;
        reference = config.extensions?.[reference];
        if (typeof reference !== "string")
          throw new Error(
            `Cannot resolve extension alias ${declaration.value}.`
          );
        // Bicep resolves explicit aliases against the config, but implicit
        // aliases directly against each referencing source file.
        if (declaration.kind === "extension-alias")
          relativeTo = path.dirname(configPath);
      }
      if (reference.startsWith("br/")) {
        const separator = reference.indexOf(":");
        const alias = config.moduleAliases?.br?.[reference.slice(3, separator)];
        if (!alias || typeof alias.registry !== "string")
          throw new Error(`Cannot resolve registry alias ${reference}.`);
        reference = `br:${alias.registry}/${alias.modulePath ? `${alias.modulePath}/` : ""}${reference.slice(separator + 1)}`;
      }
      if (reference.startsWith("br:")) {
        if (!extension)
          throw new Error(
            "Remote module inputs are outside the repair workspace."
          );
        const artifact = extensionCache(cacheRoot, reference);
        for (const name of ["types.tgz", "manifest", "metadata"])
          add(path.join(artifact, name), cacheRoot);
      } else {
        if (
          reference.includes(":") ||
          path.isAbsolute(reference) ||
          path.win32.isAbsolute(reference)
        )
          throw new Error(`Unconfined repair artifact: ${reference}`);
        const local = path.resolve(relativeTo, reference);
        const confined = path.relative(root, local);
        if (
          !confined ||
          confined === ".." ||
          confined.startsWith(`..${path.sep}`) ||
          path.isAbsolute(confined)
        )
          throw new Error(`Unconfined repair artifact: ${reference}`);
        add(local, root);
        if (extension) {
          const hash = repairFileFingerprint(root, local, files).hash;
          add(
            path.join(cacheRoot, "local", `sha256_${hash}`, "types.tgz"),
            cacheRoot
          );
        } else if (!/\.jsonc?$/iu.test(local)) {
          const resolved = sourceFiles.find((file) =>
            process.platform === "win32" ?
              file.toLowerCase() === local.toLowerCase()
            : file === local
          );
          if (!resolved)
            throw new Error(
              `Compiler did not resolve local module or import: ${local}`
            );
          pending.push(resolved);
        }
      }
    }
  }
  return inputs;
}
