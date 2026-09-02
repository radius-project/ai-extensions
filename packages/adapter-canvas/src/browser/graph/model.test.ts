import { describe, expect, it } from "vitest";
import type { ResourceOutput } from "./model.js";
import {
  buildSourceUrl,
  githubRepositoryUrl,
  githubSourceReferenceUrl,
  parseGraphResources,
  radiusDeployBadgeAlt,
  radiusDeployBadgeKind,
  radiusDeployBadgeSvg,
  radiusFormatResolvedTypeLabel,
  radiusFormatTypeLabel,
  radiusGetIconSvg,
  radiusGetTypeStyle,
  radiusIsManagedClusterResource,
  radiusIsManagedClusterType,
  radiusNormalizeIcon,
  radiusResolveIcon,
  radiusNormalizeIconSource,
  radiusResolveIconSource,
  radiusResolvedOutputRank,
  radiusSelectResolvedResource,
  srcLineFromRef,
  srcPathFromRef
} from "./model.js";

describe("parseGraphResources", () => {
  it("keeps only object resources", () => {
    expect(parseGraphResources([{ id: "a" }, null, "bad", ["bad"]])).toEqual([
      { id: "a" }
    ]);
    expect(parseGraphResources(null)).toEqual([]);
  });
});

describe("githubRepositoryUrl", () => {
  it("accepts one owner/repository pair and rejects URL-shaped input", () => {
    expect(githubRepositoryUrl("octo/app.repo")).toBe(
      "https://github.com/octo/app.repo"
    );
    expect(githubRepositoryUrl("octo/app/extra")).toBe("");
    expect(githubRepositoryUrl("https://example.test/o/r")).toBe("");
  });
});

describe("radiusDeployBadgeKind", () => {
  it("defaults an absent status to the in-progress badge", () => {
    expect(radiusDeployBadgeKind()).toBe("progress");
    expect(radiusDeployBadgeKind("")).toBe("progress");
  });

  it("maps success and failed to their own badges", () => {
    expect(radiusDeployBadgeKind("success")).toBe("success");
    expect(radiusDeployBadgeKind("failed")).toBe("failed");
  });

  it("treats every other status as in progress", () => {
    expect(radiusDeployBadgeKind("pending")).toBe("progress");
    expect(radiusDeployBadgeKind("in_progress")).toBe("progress");
    expect(radiusDeployBadgeKind("weird")).toBe("progress");
  });
});

describe("radiusDeployBadgeAlt", () => {
  it("names each badge state", () => {
    expect(radiusDeployBadgeAlt("failed")).toBe("Failed");
    expect(radiusDeployBadgeAlt("success")).toBe("Deployed");
    expect(radiusDeployBadgeAlt("progress")).toBe("In progress");
  });
});

describe("radiusIsManagedClusterType", () => {
  it("detects the AKS managed cluster type regardless of version or case", () => {
    expect(
      radiusIsManagedClusterType(
        "Microsoft.ContainerService/managedClusters@2023-01-01"
      )
    ).toBe(true);
    expect(
      radiusIsManagedClusterType("microsoft.containerservice/managedclusters")
    ).toBe(true);
  });

  it("returns false for other types and missing input", () => {
    expect(radiusIsManagedClusterType("Radius.Compute/containers")).toBe(false);
    expect(radiusIsManagedClusterType(undefined)).toBe(false);
    expect(radiusIsManagedClusterType("")).toBe(false);
  });
});

describe("radiusIsManagedClusterResource", () => {
  it("returns false when there is no resource", () => {
    expect(radiusIsManagedClusterResource(null)).toBe(false);
    expect(radiusIsManagedClusterResource(undefined)).toBe(false);
  });

  it("detects a managed cluster by the resource type", () => {
    expect(
      radiusIsManagedClusterResource({
        type: "Microsoft.ContainerService/managedClusters"
      })
    ).toBe(true);
  });

  it("detects a managed cluster nested in the output resources", () => {
    expect(
      radiusIsManagedClusterResource({
        type: "Radius.Compute/containers",
        outputResources: [
          { type: "microsoft.containerservice/managedclusters" }
        ]
      })
    ).toBe(true);
  });

  it("tolerates a missing output entry and returns false for plain resources", () => {
    // A sparse hole exercises the outputs[i] guard the same way a null entry in
    // server data would.
    const outputResources: ResourceOutput[] = [];
    outputResources[1] = { type: "kubernetes/Deployment" };
    expect(
      radiusIsManagedClusterResource({
        type: "Radius.Compute/containers",
        outputResources
      })
    ).toBe(false);
  });

  it("defaults absent output resources to an empty list", () => {
    expect(
      radiusIsManagedClusterResource({ type: "Radius.Compute/containers" })
    ).toBe(false);
  });
});

describe("radiusDeployBadgeSvg", () => {
  it("returns a success badge with a green check and the 40px size", () => {
    const uri = radiusDeployBadgeSvg("success");
    expect(uri.indexOf("data:image/svg+xml,")).toBe(0);
    const svg = decodeURIComponent(uri.slice("data:image/svg+xml,".length));
    expect(svg).toContain('width="40" height="40"');
    expect(svg).toContain('fill="#1a7f37"');
  });

  it("returns the failed badge markup", () => {
    const svg = decodeURIComponent(
      radiusDeployBadgeSvg("failed").slice("data:image/svg+xml,".length)
    );
    expect(svg).toContain('stroke="#cf222e"');
  });

  it("defaults to the progress badge", () => {
    const fallback = decodeURIComponent(
      radiusDeployBadgeSvg().slice("data:image/svg+xml,".length)
    );
    expect(fallback).toContain('stroke="#0969da"');
    expect(fallback).toContain("animation:spin 1s linear infinite");
    expect(fallback).toContain("prefers-reduced-motion:reduce");
    expect(fallback).toContain(".spinner{animation:none}");
    expect(radiusDeployBadgeSvg("anything-else")).toBe(radiusDeployBadgeSvg());
  });

  it("keeps progress animated indefinitely and leaves terminal badges static", () => {
    const progress = decodeURIComponent(
      radiusDeployBadgeSvg("progress").slice("data:image/svg+xml,".length)
    );
    expect(progress).toContain("animation:spin 1s linear infinite");

    for (const terminal of ["success", "failed"]) {
      const svg = decodeURIComponent(
        radiusDeployBadgeSvg(terminal).slice("data:image/svg+xml,".length)
      );
      expect(svg).not.toContain("@keyframes spin");
    }
  });

  it("memoizes each kind so repeat calls return the identical string", () => {
    expect(radiusDeployBadgeSvg("success")).toBe(
      radiusDeployBadgeSvg("success")
    );
  });
});

describe("radiusGetIconSvg", () => {
  it("returns an empty string when the type is missing", () => {
    expect(radiusGetIconSvg()).toBe("");
    expect(radiusGetIconSvg("")).toBe("");
  });

  function fillOf(type: string): string {
    const svg = decodeURIComponent(
      radiusGetIconSvg(type).slice("data:image/svg+xml,".length)
    );
    const match = svg.match(/fill="([^"]+)"/);
    return match ? match[1] : "";
  }

  it("injects the 64px canvas size", () => {
    const svg = decodeURIComponent(
      radiusGetIconSvg("Radius.Compute/containers").slice(
        "data:image/svg+xml,".length
      )
    );
    expect(svg).toContain('width="64" height="64"');
  });

  it("selects an icon per resource family", () => {
    expect(fillOf("Radius.Compute/containers")).toBe("#326ce5");
    expect(fillOf("aws.ecr/repository")).toBe("var(--rad-brand, #da4c2a)");
    expect(fillOf("Applications.Core/gateways")).toBe("#8250df");
    expect(fillOf("kubernetes/route")).toBe("#8250df");
    expect(fillOf("azure.dbformysql/servers")).toBe("#00758f");
    expect(fillOf("azure.dbforpostgresql/servers")).toBe("#336791");
    expect(fillOf("redis/cache")).toBe("#d82c20");
    expect(fillOf("aws.rds/db_instance")).toBe("#e48400");
    expect(fillOf("mongo/database")).toBe("#13aa52");
    expect(fillOf("neo4j/graph")).toBe("#018bff");
    expect(fillOf("rabbitmq/queues")).toBe("#ff6600");
    expect(fillOf("azure.keyvault/secret")).toBe("#1a7f37");
    expect(fillOf("kubernetes/persistentVolume")).toBe("#8764b8");
    expect(fillOf("aws.vpc/subnet")).toBe("#0078d4");
    expect(fillOf("kubernetes/service")).toBe("#326ce5");
    expect(fillOf("kubernetes/deployment")).toBe("#326ce5");
    expect(fillOf("something/unknown")).toBe("#6639ba");
  });

  it("matches ecr only as a delimited token, not inside secrets", () => {
    // 'secrets' contains the letters e-c-r, but the boundary regex must not
    // treat it as a container registry.
    expect(fillOf("aws.secretsmanager/secret")).toBe("#1a7f37");
  });
});

describe("radiusGetTypeStyle", () => {
  it("classifies compute workloads", () => {
    expect(radiusGetTypeStyle("Radius.Compute/containers").category).toBe(
      "Compute"
    );
    expect(radiusGetTypeStyle("kubernetes/deployment").category).toBe(
      "Compute"
    );
    expect(radiusGetTypeStyle("kubernetes/service").category).toBe("Compute");
  });

  it("classifies registries, caches and data stores", () => {
    expect(radiusGetTypeStyle("aws.ecr/repository").category).toBe("Registry");
    expect(radiusGetTypeStyle("redis/cache").category).toBe("Cache");
    expect(radiusGetTypeStyle("azure.dbformysql/servers").category).toBe(
      "Data Store"
    );
  });

  it("classifies secrets, networking, messaging and storage", () => {
    const secrets = radiusGetTypeStyle("aws.secretsmanager/secret");
    expect(secrets.category).toBe("Secrets");
    expect(secrets.bg).toBe("#e9f5ee");
    expect(radiusGetTypeStyle("kubernetes/route").category).toBe("Networking");
    expect(radiusGetTypeStyle("rabbitmq/queue").category).toBe("Messaging");
    expect(radiusGetTypeStyle("kubernetes/persistentVolume").category).toBe(
      "Storage"
    );
  });

  it("falls back to Other for unknown types and missing input", () => {
    expect(radiusGetTypeStyle("mystery/thing").category).toBe("Other");
    expect(radiusGetTypeStyle().category).toBe("Other");
  });
});

describe("radiusNormalizeIcon", () => {
  it("rejects non-string and empty input", () => {
    expect(radiusNormalizeIcon(null)).toBe("");
    expect(radiusNormalizeIcon(42)).toBe("");
    expect(radiusNormalizeIcon("   ")).toBe("");
  });

  it("passes through data and http(s) URLs untouched", () => {
    expect(radiusNormalizeIcon("data:image/png;base64,AAAA")).toBe(
      "data:image/png;base64,AAAA"
    );
    expect(radiusNormalizeIcon("http://x/i.svg")).toBe("http://x/i.svg");
    expect(radiusNormalizeIcon("https://x/i.svg")).toBe("https://x/i.svg");
  });

  it("wraps raw svg markup and injects a size when absent", () => {
    const out = radiusNormalizeIcon('<svg viewBox="0 0 8 8"></svg>');
    expect(out.indexOf("data:image/svg+xml,")).toBe(0);
    expect(decodeURIComponent(out.slice("data:image/svg+xml,".length))).toBe(
      '<svg width="64" height="64" viewBox="0 0 8 8"></svg>'
    );
  });

  it("keeps an existing width on raw svg markup", () => {
    const out = radiusNormalizeIcon('<svg width="10" height="10"></svg>');
    expect(decodeURIComponent(out.slice("data:image/svg+xml,".length))).toBe(
      '<svg width="10" height="10"></svg>'
    );
  });

  it("returns empty for anything else", () => {
    expect(radiusNormalizeIcon("just-a-name")).toBe("");
  });
});

describe("radiusNormalizeIconSource", () => {
  it("marks raw svg markup that paints in currentColor as monochrome", () => {
    const out = radiusNormalizeIconSource(
      '<svg viewBox="0 0 8 8"><rect fill="currentColor" /></svg>'
    );
    expect(out.monochrome).toBe(true);
    expect(decodeURIComponent(out.src)).toContain('fill="currentColor"');
  });

  it("does not mark multi-color svg markup, urls or data uris as monochrome", () => {
    expect(
      radiusNormalizeIconSource('<svg viewBox="0 0 8 8" fill="#326ce5"></svg>')
        .monochrome
    ).toBe(false);
    expect(
      radiusNormalizeIconSource("data:image/png;base64,AAAA").monochrome
    ).toBe(false);
    expect(radiusNormalizeIconSource("https://x/i.svg").monochrome).toBe(false);
    expect(radiusNormalizeIconSource("just-a-name")).toEqual({
      src: "",
      monochrome: false
    });
    expect(radiusNormalizeIconSource(null)).toEqual({
      src: "",
      monochrome: false
    });
    expect(radiusNormalizeIconSource("  ")).toEqual({
      src: "",
      monochrome: false
    });
  });
});

describe("radiusResolveIconSource", () => {
  it("never marks a built-in fallback glyph as monochrome", () => {
    const glyph = radiusResolveIconSource({ type: "redis/cache" });
    expect(glyph).toEqual({
      src: radiusGetIconSvg("redis/cache"),
      monochrome: false
    });
    expect(radiusResolveIconSource(null)).toEqual({
      src: "",
      monochrome: false
    });
  });

  it("carries a pack icon's monochrome flag through", () => {
    expect(
      radiusResolveIconSource({
        icon: '<svg viewBox="0 0 8 8"><rect fill="currentColor" /></svg>',
        type: "redis/cache"
      }).monochrome
    ).toBe(true);
  });
});

describe("radiusResolveIcon", () => {
  it("prefers a pack-supplied icon", () => {
    expect(
      radiusResolveIcon({ icon: "https://x/i.svg", type: "redis/cache" })
    ).toBe("https://x/i.svg");
  });

  it("falls back to the type glyph, then displayType, then nothing", () => {
    expect(radiusResolveIcon({ type: "redis/cache" })).toBe(
      radiusGetIconSvg("redis/cache")
    );
    expect(radiusResolveIcon({ displayType: "redis/cache" })).toBe(
      radiusGetIconSvg("redis/cache")
    );
    expect(radiusResolveIcon(null)).toBe("");
  });
});

describe("radiusFormatTypeLabel", () => {
  it("returns empty for missing type", () => {
    expect(radiusFormatTypeLabel()).toBe("");
  });

  it("returns the type unchanged when there is no slash", () => {
    expect(radiusFormatTypeLabel("standalone")).toBe("standalone");
  });

  it("strips the vendor prefix and api version", () => {
    expect(
      radiusFormatTypeLabel("Radius.Compute/containers@2023-10-01-preview")
    ).toBe("Compute/containers");
  });

  it("keeps a namespace without a dot", () => {
    expect(radiusFormatTypeLabel("kubernetes/Deployment")).toBe(
      "kubernetes/Deployment"
    );
  });
});

describe("radiusFormatResolvedTypeLabel", () => {
  it("returns empty for missing type and strips the version otherwise", () => {
    expect(radiusFormatResolvedTypeLabel()).toBe("");
    expect(
      radiusFormatResolvedTypeLabel("Microsoft.DBforMySQL/flexibleServers@2023")
    ).toBe("Microsoft.DBforMySQL/flexibleServers");
  });
});

describe("radiusResolvedOutputRank", () => {
  it("ranks nested child resources lowest", () => {
    expect(
      radiusResolvedOutputRank({
        type: "Microsoft.DBforMySQL/flexibleServers/firewallRules"
      })
    ).toBe(0);
  });

  it("ranks known supporting kinds below the primary", () => {
    expect(radiusResolvedOutputRank({ type: "core/Secret" })).toBe(1);
    expect(radiusResolvedOutputRank({ displayType: "core/Service" })).toBe(1);
  });

  it("ranks everything else as a primary candidate", () => {
    expect(radiusResolvedOutputRank({ type: "apps/Deployment" })).toBe(2);
  });
});

describe("radiusSelectResolvedResource", () => {
  it("returns null when there is no resource or no typed outputs", () => {
    expect(radiusSelectResolvedResource(null)).toBeNull();
    expect(radiusSelectResolvedResource({})).toBeNull();
    expect(
      radiusSelectResolvedResource({ outputResources: [{ name: "untyped" }] })
    ).toBeNull();
  });

  it("prefers the highest-ranked output and keeps declaration order on ties", () => {
    const primary = { id: "p", type: "apps/Deployment" };
    const chosen = radiusSelectResolvedResource({
      outputResources: [
        { type: "core/Secret" },
        primary,
        { type: "core/Service" }
      ]
    });
    expect(chosen).toBe(primary);
  });

  it("keeps the first candidate when ranks tie", () => {
    const first = { type: "apps/Deployment" };
    const chosen = radiusSelectResolvedResource({
      outputResources: [first, { type: "apps/StatefulSet" }]
    });
    expect(chosen).toBe(first);
  });

  it("excludes outputs owned by a different top-level resource", () => {
    const chosen = radiusSelectResolvedResource(
      {
        outputResources: [
          { id: "owned-by-other", type: "apps/Deployment" },
          { id: "mine", type: "core/Secret" }
        ]
      },
      { "owned-by-other": "other" },
      "me"
    );
    expect(chosen && chosen.id).toBe("mine");
  });

  it("keeps outputs that this resource owns", () => {
    const chosen = radiusSelectResolvedResource(
      { outputResources: [{ id: "mine", type: "apps/Deployment" }] },
      { mine: "me" },
      "me"
    );
    expect(chosen && chosen.id).toBe("mine");
  });
});

describe("buildSourceUrl", () => {
  it("returns empty without a repo url", () => {
    expect(buildSourceUrl("", "main", "app.bicep")).toBe("");
  });

  it("deep-links to a file and line when a code reference is present", () => {
    expect(
      buildSourceUrl("https://github.com/o/r", "main", "src/app.bicep#L12")
    ).toBe("https://github.com/o/r/blob/main/src/app.bicep#L12");
  });

  it("preserves an exact GitHub branch and file URL without repo context", () => {
    const reference =
      "https://github.com/acme/widgets/blob/release/src/app.ts#L12";
    expect(buildSourceUrl("", "", reference)).toBe(reference);
    expect(githubSourceReferenceUrl(reference)).toBe(reference);
    expect(srcPathFromRef(reference)).toBe("");
    expect(srcLineFromRef(reference)).toBe(0);
  });

  it.each([
    "http://github.com/acme/widgets/blob/main/src/app.ts",
    "https://example.com/acme/widgets/blob/main/src/app.ts",
    "https://github.com/acme/widgets/tree/main/src",
    "https://github.com/acme/widgets/blob/main/src/app.ts?plain=1",
    "https://github.com/acme/widgets/blob/main/src/app.ts#L0",
    " https://github.com/acme/widgets/blob/main/src/app.ts",
    "https://github.com/acme/widgets/blob/main/src/app.ts\nforged"
  ])("rejects a non-canonical GitHub file URL: %s", (reference) => {
    expect(githubSourceReferenceUrl(reference)).toBe("");
  });

  it.each([
    "[parameters('sourceReference')]",
    "src/app.ts\nforged",
    "src/app.ts#L0",
    "src/app.ts#section"
  ])(
    "falls back to the repository for an invalid local reference: %s",
    (reference) => {
      expect(
        buildSourceUrl("https://github.com/acme/widgets", "main", reference)
      ).toBe("https://github.com/acme/widgets/tree/main");
    }
  );

  it("omits the line fragment when the reference has none", () => {
    expect(
      buildSourceUrl("https://github.com/o/r", "main", "src/app.bicep")
    ).toBe("https://github.com/o/r/blob/main/src/app.bicep");
  });

  it("falls back to the repo tree when there is no code reference", () => {
    expect(buildSourceUrl("https://github.com/o/r", "main", "")).toBe(
      "https://github.com/o/r/tree/main"
    );
  });

  it("honours a branch override", () => {
    expect(
      buildSourceUrl("https://github.com/o/r", "main", "", "feature")
    ).toBe("https://github.com/o/r/tree/feature");
  });

  it("converts a Windows path and strips a leading slash", () => {
    expect(
      buildSourceUrl("https://github.com/o/r", "main", "\\src\\app.bicep#L3")
    ).toBe("https://github.com/o/r/blob/main/src/app.bicep#L3");
  });

  it("encodes branch and path segments without changing their hierarchy", () => {
    expect(
      buildSourceUrl(
        "https://github.com/o/r/",
        "feature/my work",
        "src/my file%20.ts#L8"
      )
    ).toBe(
      "https://github.com/o/r/blob/feature/my%20work/src/my%20file%2520.ts#L8"
    );
  });

  it("falls back to the branch tree for an unsafe source path", () => {
    expect(
      buildSourceUrl("https://github.com/o/r", "feature", "../outside.ts#L1")
    ).toBe("https://github.com/o/r/tree/feature");
    expect(srcPathFromRef("C:\\outside.ts#L1")).toBe("");
    expect(srcLineFromRef("C:\\outside.ts#L1")).toBe(0);
  });
});

describe("srcPathFromRef", () => {
  it("returns empty for no reference", () => {
    expect(srcPathFromRef("")).toBe("");
  });

  it("converts Windows backslashes and strips a leading slash", () => {
    expect(srcPathFromRef("src\\graph\\diff.ts#L14")).toBe("src/graph/diff.ts");
    expect(srcPathFromRef("/src/app.bicep")).toBe("src/app.bicep");
  });
});

describe("srcLineFromRef", () => {
  it("returns 0 without a line fragment", () => {
    expect(srcLineFromRef("")).toBe(0);
    expect(srcLineFromRef("src/app.bicep")).toBe(0);
  });

  it("parses the 1-based line number", () => {
    expect(srcLineFromRef("src/app.bicep#L42")).toBe(42);
  });

  it("returns 0 for an unparsable line", () => {
    expect(srcLineFromRef("src/app.bicep#Labc")).toBe(0);
  });
});
