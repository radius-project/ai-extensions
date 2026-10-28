import { createHash } from "node:crypto";

const MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
const TEMPLATE_MEDIA_TYPE = "application/vnd.ms.bicep.module.layer.v1+json";
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MAX_BYTES = 5 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

export type RecipeImplementation =
  | {
      status: "available";
      source: string;
      resolvedSource: string;
      sourceIsDigest: boolean;
      manifestDigest: string;
      templateDigest: string;
      format: "arm-template";
      template: JsonObject;
    }
  | { status: "unavailable"; message: string };

interface Options {
  fetchImpl?: typeof fetch;
  fetchTimeoutMs?: number;
  maxResponseBytes?: number;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function parseObject(bytes: Uint8Array): JsonObject {
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  );
  if (!isObject(value))
    throw new Error("Recipe artifact must contain a JSON object.");
  return value;
}

function registrationSource(definition: string): string {
  const normalized = definition.replaceAll("\r\n", "\n");
  // Match only direct fields of the extracted registration, never nested parameters.
  const start = /^([ \t]*)'Radius[^\r\n]+'\s*:\s*\{/u.exec(normalized);
  if (start?.[1] === undefined)
    throw new Error("Recipe registration has no resource entry.");
  const indentation = start[1].length + 2;
  const fields = [
    ...normalized.matchAll(
      /^([ \t]+)(kind|source):[ \t]*'([^'\r\n]*)'[ \t]*(?:\/\/[^\r\n]*)?$/gmu
    )
  ].filter((match) => match[1]?.length === indentation);
  const kinds = fields.filter((match) => match[2] === "kind");
  const sources = fields.filter((match) => match[2] === "source");
  const source = sources[0]?.[3];
  if (
    kinds.length !== 1 ||
    kinds[0]?.[3] !== "bicep" ||
    sources.length !== 1 ||
    source === undefined
  ) {
    throw new Error(
      "Recipe evidence requires one literal Bicep kind and source."
    );
  }
  return source;
}

async function request(
  url: string,
  accept: string,
  authorization: string | undefined,
  blobRegistry: "ghcr.io" | "mcr.microsoft.com" | undefined,
  {
    fetchImpl = fetch,
    fetchTimeoutMs = 15_000,
    maxResponseBytes = MAX_BYTES
  }: Options
): Promise<{ bytes: Uint8Array; declaredDigest: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const headers: Record<string, string> = { accept };
    if (authorization) headers.authorization = authorization;
    let response = await fetchImpl(url, {
      headers,
      redirect: "manual",
      signal: controller.signal
    });
    if (
      blobRegistry !== undefined &&
      (response.status === 307 || response.status === 302)
    ) {
      const location = new URL(response.headers.get("location") ?? "", url);
      // Only registry-owned blob CDNs are allowed. Never forward a bearer token.
      const allowedHost =
        blobRegistry === "ghcr.io" ?
          location.hostname === "pkg-containers.githubusercontent.com"
        : /^[a-z0-9-]+\.data\.mcr\.microsoft\.com$/u.test(location.hostname);
      if (
        location.protocol !== "https:" ||
        !allowedHost ||
        location.port !== "" ||
        location.username !== "" ||
        location.password !== ""
      ) {
        throw new Error("Recipe blob redirected to an unsupported source.");
      }
      await response.body?.cancel();
      response = await fetchImpl(location.href, {
        headers: { accept },
        redirect: "error",
        signal: controller.signal
      });
    }
    if (!response.ok || response.redirected) {
      throw new Error(
        `Recipe artifact request failed with HTTP ${response.status} or an unexpected redirect.`
      );
    }
    if (Number(response.headers.get("content-length")) > maxResponseBytes) {
      await response.body?.cancel();
      throw new Error(`Recipe artifact exceeded ${maxResponseBytes} bytes.`);
    }
    if (!response.body)
      throw new Error("Recipe artifact response has no body.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxResponseBytes) {
          await reader.cancel();
          throw new Error(
            `Recipe artifact exceeded ${maxResponseBytes} bytes.`
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return {
      bytes: Buffer.concat(chunks, size),
      declaredDigest: response.headers.get("docker-content-digest")
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** Read public first-party Recipe artifacts without using local registry credentials. */
export async function resolveRecipeImplementation(
  definition: string,
  options: Options = {}
): Promise<RecipeImplementation> {
  try {
    const source = registrationSource(definition);
    const match =
      /^(ghcr\.io\/radius-project\/kube-recipes\/[a-z0-9-]+|mcr\.microsoft\.com\/bicep\/avm\/[a-z0-9/-]+)(?::([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})|@(sha256:[0-9a-f]{64}))$/u.exec(
        source
      );
    const repository = match?.[1];
    const reference = match?.[2] ?? match?.[3];
    if (!match || repository === undefined || reference === undefined)
      throw new Error(
        "Recipe source is not a supported public Radius or AVM OCI reference."
      );
    const separator = repository.indexOf("/");
    const host = repository.slice(0, separator);
    const name = repository.slice(separator + 1);
    if (
      name
        .split("/")
        .some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error("Recipe source contains an invalid repository path.");
    }
    let authorization: string | undefined;
    if (host === "ghcr.io") {
      const tokenResponse = await request(
        `https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${name}:pull`)}`,
        "application/json",
        undefined,
        undefined,
        options
      );
      const token = parseObject(tokenResponse.bytes).token;
      if (
        typeof token !== "string" ||
        token.length === 0 ||
        /[\r\n]/u.test(token)
      ) {
        throw new Error(
          "Recipe registry did not return an anonymous pull token."
        );
      }
      authorization = `Bearer ${token}`;
    }
    const manifestResponse = await request(
      `https://${host}/v2/${name}/manifests/${reference}`,
      MANIFEST_MEDIA_TYPE,
      authorization,
      undefined,
      options
    );
    const manifestDigest = digest(manifestResponse.bytes);
    if (
      (match[3] && match[3] !== manifestDigest) ||
      (manifestResponse.declaredDigest &&
        manifestResponse.declaredDigest !== manifestDigest)
    ) {
      throw new Error(
        "Recipe manifest digest does not match the requested or advertised identity."
      );
    }
    const manifest = parseObject(manifestResponse.bytes);
    if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.layers)) {
      throw new Error("Recipe artifact is not an OCI image manifest.");
    }
    const layers = manifest.layers.filter(
      (layer: unknown) =>
        isObject(layer) && layer.mediaType === TEMPLATE_MEDIA_TYPE
    );
    const layer: unknown = layers[0];
    if (
      layers.length !== 1 ||
      !isObject(layer) ||
      typeof layer.digest !== "string" ||
      !DIGEST.test(layer.digest) ||
      !Number.isSafeInteger(layer.size) ||
      typeof layer.size !== "number" ||
      layer.size <= 0 ||
      layer.size > (options.maxResponseBytes ?? MAX_BYTES)
    ) {
      throw new Error(
        "Recipe manifest must identify one bounded Bicep template layer."
      );
    }
    const templateResponse = await request(
      `https://${host}/v2/${name}/blobs/${layer.digest}`,
      TEMPLATE_MEDIA_TYPE,
      authorization,
      host === "ghcr.io" ? "ghcr.io" : "mcr.microsoft.com",
      options
    );
    if (
      templateResponse.bytes.byteLength !== layer.size ||
      digest(templateResponse.bytes) !== layer.digest
    ) {
      throw new Error(
        "Recipe template does not match its OCI size and digest."
      );
    }
    const template = parseObject(templateResponse.bytes);
    if (
      typeof template.$schema !== "string" ||
      !template.$schema.endsWith("/deploymentTemplate.json#") ||
      (!isObject(template.resources) && !Array.isArray(template.resources))
    ) {
      throw new Error(
        "Recipe layer is not a compiled ARM deployment template."
      );
    }
    return {
      status: "available",
      source,
      resolvedSource: `${repository}@${manifestDigest}`,
      sourceIsDigest: match[3] !== undefined,
      manifestDigest,
      templateDigest: layer.digest,
      format: "arm-template",
      template
    };
  } catch (error) {
    // Do not leak signed CDN URLs or anonymous bearer tokens through fetch errors.
    const detail =
      error instanceof Error && error.message.startsWith("Recipe ") ?
        error.message
      : "Recipe implementation could not be read (network, timeout, or invalid JSON).";
    return {
      status: "unavailable",
      message: `${detail} Retry the resolver or supply the exact implementation and its immutable identity in the modeling context; do not infer behavior from the registration.`
    };
  }
}
