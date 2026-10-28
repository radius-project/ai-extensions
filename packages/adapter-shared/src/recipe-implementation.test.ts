import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRecipeImplementation } from "./recipe-implementation.js";

const source = "ghcr.io/radius-project/kube-recipes/rabbitmq:latest";
const avm =
  "mcr.microsoft.com/bicep/avm/res/db-for-postgre-sql/flexible-server:0.15.2";
const template = {
  $schema:
    "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  resources: { broker: { image: "rabbitmq:4-alpine" } },
  parameters: { password: { type: "securestring" } },
  outputs: {
    result: { value: { secrets: { password: "[parameters('password')]" } } }
  }
};
const sha = (text: string) =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;
const registration = (value = source) => `      'Radius.Messaging/rabbitMQ': {
        kind: 'bicep'
        source: '${value}'
      }`;

function fixture(templateText = JSON.stringify(template)) {
  const layer = {
    mediaType: "application/vnd.ms.bicep.module.layer.v1+json",
    digest: sha(templateText),
    size: Buffer.byteLength(templateText)
  };
  const manifest = { schemaVersion: 2, layers: [layer] };
  const fetchImpl = vi.fn<typeof fetch>(async (url) => {
    const value = String(url);
    if (value.includes("/token?"))
      return Response.json({ token: "anonymous-fixture" });
    if (value.includes("/manifests/"))
      return new Response(JSON.stringify(manifest));
    if (value.endsWith(`/blobs/${layer.digest}`))
      return new Response(templateText);
    throw new Error(`Unexpected request: ${value}`);
  });
  return { fetchImpl, manifest, layer };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("resolveRecipeImplementation", () => {
  it("retrieves behavior rather than treating an OCI registration as implementation evidence", async () => {
    const { fetchImpl, manifest, layer } = fixture();
    const result = await resolveRecipeImplementation(registration(), {
      fetchImpl
    });
    expect(result).toEqual({
      status: "available",
      source,
      resolvedSource: `${source.split(":")[0]}@${sha(JSON.stringify(manifest))}`,
      sourceIsDigest: false,
      manifestDigest: sha(JSON.stringify(manifest)),
      templateDigest: layer.digest,
      format: "arm-template",
      template
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://ghcr.io/token?service=ghcr.io&scope=repository%3Aradius-project%2Fkube-recipes%2Frabbitmq%3Apull"
    );
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      headers: { authorization: "Bearer anonymous-fixture" },
      redirect: "manual"
    });
  });

  it("supports immutable sources and anonymous AVM retrieval through the default fetch", async () => {
    const { fetchImpl, manifest } = fixture();
    vi.stubGlobal("fetch", fetchImpl);
    const immutable = `${avm.split(":")[0]}@${sha(JSON.stringify(manifest))}`;
    expect(
      await resolveRecipeImplementation(registration(immutable))
    ).toMatchObject({
      status: "available",
      sourceIsDigest: true,
      source: immutable,
      resolvedSource: immutable
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      "authorization"
    );
  });

  it("accepts CRLF registration text and ignores nested source and kind parameters", async () => {
    const { fetchImpl } = fixture();
    const definition = registration()
      .replace(
        "      }",
        "        parameters: {\n          source: 'ignored'\n          kind: 'terraform'\n        }\n      }"
      )
      .replaceAll("\n", "\r\n");
    expect(
      await resolveRecipeImplementation(definition, { fetchImpl })
    ).toMatchObject({
      status: "available",
      source
    });
  });

  it("does not allow an MCR blob redirect to a different registry's CDN", async () => {
    const { fetchImpl, manifest } = fixture();
    fetchImpl
      .mockResolvedValueOnce(Response.json(manifest))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: {
            location: "https://pkg-containers.githubusercontent.com/blob"
          }
        })
      );
    expect(
      await resolveRecipeImplementation(registration(avm), { fetchImpl })
    ).toMatchObject({ status: "unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("accepts the exact byte limit and array-form ARM resources", async () => {
    const value = JSON.stringify({ ...template, resources: [] });
    const { fetchImpl } = fixture(value);
    expect(
      await resolveRecipeImplementation(registration(avm), {
        fetchImpl,
        maxResponseBytes: Buffer.byteLength(value)
      })
    ).toMatchObject({ status: "available" });
  });

  it("follows an MCR data CDN redirect without using registry credentials", async () => {
    const { fetchImpl, manifest } = fixture();
    fetchImpl
      .mockResolvedValueOnce(Response.json(manifest))
      .mockResolvedValueOnce(
        new Response("redirect", {
          status: 307,
          headers: { location: "https://westus2.data.mcr.microsoft.com/blob" }
        })
      )
      .mockResolvedValueOnce(Response.json(template));
    expect(
      await resolveRecipeImplementation(registration(avm), { fetchImpl })
    ).toMatchObject({ status: "available" });
    expect(fetchImpl.mock.calls[2]?.[1]?.headers).not.toHaveProperty(
      "authorization"
    );
  });

  it.each([
    ["no entry", "source: 'anything'"],
    ["nonliteral kind", registration().replace("'bicep'", "kindParameter")],
    ["wrong kind", registration().replace("'bicep'", "'terraform'")],
    [
      "duplicate source",
      registration().replace(
        "        kind:",
        `        source: '${source}'\n        kind:`
      )
    ],
    [
      "nested source only",
      registration().replace("        source:", "          source:")
    ],
    ["untrusted host", registration("evil.example/recipe:latest")],
    [
      "wrong GHCR owner",
      registration("ghcr.io/example/kube-recipes/rabbitmq:latest")
    ],
    [
      "missing tag",
      registration("ghcr.io/radius-project/kube-recipes/rabbitmq")
    ],
    [
      "path traversal",
      registration("mcr.microsoft.com/bicep/avm/../secret:latest")
    ],
    [
      "empty path segment",
      registration("mcr.microsoft.com/bicep/avm/res//server:latest")
    ],
    [
      "nonsha digest",
      registration("ghcr.io/radius-project/kube-recipes/rabbitmq@sha512:abcd")
    ]
  ])("rejects %s without fetching", async (_name, definition) => {
    const { fetchImpl } = fixture();
    expect(
      await resolveRecipeImplementation(definition, { fetchImpl })
    ).toMatchObject({
      status: "unavailable",
      message: expect.stringContaining("supply the exact implementation")
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([undefined, "", 42, "unsafe\nvalue"])(
    "rejects invalid anonymous token %s",
    async (token) => {
      const { fetchImpl } = fixture();
      fetchImpl.mockResolvedValueOnce(Response.json({ token }));
      expect(
        await resolveRecipeImplementation(registration(), { fetchImpl })
      ).toMatchObject({
        status: "unavailable",
        message: expect.stringContaining("anonymous pull token")
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    { schemaVersion: 1, layers: [] },
    { schemaVersion: 2 },
    { schemaVersion: 2, layers: [null, { mediaType: "other" }] },
    {
      schemaVersion: 2,
      layers: [
        {
          mediaType: "application/vnd.ms.bicep.module.layer.v1+json",
          digest: "bad",
          size: 1
        }
      ]
    }
  ])("rejects incomplete or unsupported manifests", async (manifest) => {
    const { fetchImpl } = fixture();
    fetchImpl.mockResolvedValueOnce(Response.json(manifest));
    expect(
      await resolveRecipeImplementation(registration(avm), { fetchImpl })
    ).toMatchObject({ status: "unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    "duplicate",
    "size-zero",
    "size-negative",
    "size-fraction",
    "size-missing",
    "size-large",
    "digest-missing"
  ])("rejects a %s layer descriptor", async (variation) => {
    const { fetchImpl, manifest, layer } = fixture();
    const invalid = { ...layer };
    if (variation === "duplicate") manifest.layers.push(layer);
    else if (variation === "digest-missing")
      Object.assign(invalid, { digest: undefined });
    else
      Object.assign(invalid, {
        size: {
          "size-zero": 0,
          "size-negative": -1,
          "size-fraction": 1.5,
          "size-missing": undefined,
          "size-large": 5 * 1024 * 1024 + 1
        }[variation]
      });
    manifest.layers[0] = invalid;
    expect(
      await resolveRecipeImplementation(registration(avm), { fetchImpl })
    ).toMatchObject({ status: "unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["requested", "advertised"])(
    "verifies the %s manifest digest",
    async (variation) => {
      const { fetchImpl, manifest } = fixture();
      const wrong = `sha256:${"0".repeat(64)}`;
      fetchImpl.mockResolvedValueOnce(
        new Response(JSON.stringify(manifest), {
          headers:
            variation === "advertised" ? { "docker-content-digest": wrong } : {}
        })
      );
      const ref =
        variation === "requested" ? `${avm.split(":")[0]}@${wrong}` : avm;
      expect(
        await resolveRecipeImplementation(registration(ref), { fetchImpl })
      ).toMatchObject({
        status: "unavailable",
        message: expect.stringContaining("manifest digest")
      });
    }
  );

  it("accepts a matching advertised manifest digest", async () => {
    const { fetchImpl, manifest } = fixture();
    const text = JSON.stringify(manifest);
    fetchImpl.mockResolvedValueOnce(
      new Response(text, { headers: { "docker-content-digest": sha(text) } })
    );
    expect(
      await resolveRecipeImplementation(registration(avm), { fetchImpl })
    ).toMatchObject({ status: "available" });
  });

  it.each(["size", "digest"])("verifies the template %s", async (variation) => {
    const { fetchImpl, manifest } = fixture();
    fetchImpl
      .mockResolvedValueOnce(Response.json(manifest))
      .mockResolvedValueOnce(
        new Response(
          variation === "size" ? "{}" : (
            JSON.stringify(template).replace("4-alpine", "3-alpine")
          )
        )
      );
    expect(
      await resolveRecipeImplementation(registration(avm), { fetchImpl })
    ).toMatchObject({
      status: "unavailable",
      message: expect.stringContaining("OCI size and digest")
    });
  });

  it.each([
    "null",
    "[]",
    "{",
    "{}",
    JSON.stringify({ $schema: "wrong", resources: [] }),
    JSON.stringify({ $schema: template.$schema, resources: null })
  ])("reports malformed template %s explicitly", async (text) => {
    const { fetchImpl } = fixture(text);
    expect(
      await resolveRecipeImplementation(registration(avm), { fetchImpl })
    ).toMatchObject({ status: "unavailable" });
  });

  it.each([302, 307])(
    "follows a public GHCR blob %s redirect without forwarding credentials",
    async (status) => {
      const { fetchImpl, manifest } = fixture();
      const redirect =
        "https://pkg-containers.githubusercontent.com/blob?signature=fixture";
      fetchImpl
        .mockResolvedValueOnce(Response.json({ token: "anonymous-fixture" }))
        .mockResolvedValueOnce(Response.json(manifest))
        .mockResolvedValueOnce(
          new Response(null, { status, headers: { location: redirect } })
        )
        .mockResolvedValueOnce(Response.json(template));
      expect(
        await resolveRecipeImplementation(registration(), { fetchImpl })
      ).toMatchObject({ status: "available" });
      expect(fetchImpl.mock.calls[3]).toEqual([
        redirect,
        {
          headers: { accept: "application/vnd.ms.bicep.module.layer.v1+json" },
          redirect: "error",
          signal: expect.any(AbortSignal)
        }
      ]);
    }
  );

  it.each([
    undefined,
    "http://pkg-containers.githubusercontent.com/blob",
    "https://evil.example/blob",
    "https://pkg-containers.githubusercontent.com:444/blob",
    "https://user@pkg-containers.githubusercontent.com/blob",
    "https://:pass@pkg-containers.githubusercontent.com/blob"
  ])("rejects an unsafe blob redirect %s", async (location) => {
    const { fetchImpl, manifest } = fixture();
    fetchImpl
      .mockResolvedValueOnce(Response.json({ token: "anonymous-fixture" }))
      .mockResolvedValueOnce(Response.json(manifest))
      .mockResolvedValueOnce(
        new Response("redirect", {
          status: 307,
          headers: location ? { location } : {}
        })
      );
    expect(
      await resolveRecipeImplementation(registration(), { fetchImpl })
    ).toMatchObject({ status: "unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403, 404, 429, 500, 307])(
    "reports HTTP %s without guessing or following authentication challenges",
    async (status) => {
      const { fetchImpl } = fixture();
      fetchImpl.mockResolvedValueOnce(new Response(null, { status }));
      expect(
        await resolveRecipeImplementation(registration(avm), { fetchImpl })
      ).toMatchObject({
        status: "unavailable",
        message: expect.stringContaining(`HTTP ${status}`)
      });
    }
  );

  it("rejects redirected responses even when a fetch adapter reports success", async () => {
    const { fetchImpl } = fixture();
    const response = Response.json({});
    Object.defineProperty(response, "redirected", { value: true });
    fetchImpl.mockResolvedValueOnce(response);
    expect(
      await resolveRecipeImplementation(registration(avm), { fetchImpl })
    ).toMatchObject({ status: "unavailable" });
  });

  it.each(["declared", "streamed", "no-body"])(
    "bounds %s response bodies",
    async (kind) => {
      const { fetchImpl } = fixture();
      fetchImpl.mockResolvedValueOnce(
        new Response(kind === "no-body" ? null : "x".repeat(501), {
          headers: kind === "declared" ? { "content-length": "501" } : {}
        })
      );
      expect(
        await resolveRecipeImplementation(registration(avm), {
          fetchImpl,
          maxResponseBytes: 500
        })
      ).toMatchObject({ status: "unavailable" });
    }
  );

  it("cancels a streaming response over the size limit and releases its reader", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(501));
      },
      cancel
    });
    const { fetchImpl } = fixture();
    fetchImpl.mockResolvedValueOnce(new Response(stream));
    await resolveRecipeImplementation(registration(avm), {
      fetchImpl,
      maxResponseBytes: 500
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("bounds timed out requests and removes the timer", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("request aborted"))
          );
        })
    );
    const result = resolveRecipeImplementation(registration(avm), {
      fetchImpl,
      fetchTimeoutMs: 10
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toMatchObject({
      status: "unavailable",
      message: expect.stringContaining("timeout")
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    new Error("https://cdn/?private-signature=secret"),
    "sensitive network error"
  ])("redacts unexpected transport errors", async (error) => {
    const { fetchImpl } = fixture();
    fetchImpl.mockRejectedValueOnce(error);
    const result = await resolveRecipeImplementation(registration(avm), {
      fetchImpl
    });
    expect(result).toMatchObject({ status: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });
});
