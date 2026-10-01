import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  containedPath,
  hash,
  HEADLAMP_IMAGE,
  styleChanges,
  TOOL_VERSIONS,
  validateCardGeometry,
  validateBundledLayout,
  validateHostSample,
  validatePeerStyles,
  validateTarEntries,
  withoutCandidateStyles
} from "../../../../scripts/fixtures/headlamp/contracts.mjs";

const card = {
  cssWidth: "220px",
  left: 0,
  right: 220,
  top: 0,
  bottom: 118,
  width: 220,
  height: 118
};

describe("real Headlamp qualification contracts", () => {
  it("reports exact changed CSS properties without hiding collateral changes", () => {
    const before = { ".control": [{ width: "26px", height: "26px" }] };
    expect(styleChanges(before, before)).toEqual([]);
    expect(
      styleChanges(before, { ".control": [{ width: "16px", height: "26px" }] })
    ).toEqual([
      {
        selector: ".control",
        index: 0,
        property: "width",
        before: "26px",
        after: "16px"
      }
    ]);
  });

  it.each([{}, { ".control": [] }, { ".control": [{ height: "26px" }] }])(
    "rejects incomparable CSS sample shapes",
    (after) => {
      expect(() =>
        styleChanges({ ".control": [{ width: "26px" }] }, after)
      ).toThrow();
    }
  );

  it("pins the official host image and published toolchain independently", () => {
    expect(HEADLAMP_IMAGE).toMatch(
      /^ghcr\.io\/headlamp-k8s\/headlamp:v0\.45\.0@sha256:[a-f0-9]{64}$/
    );
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "../../../../scripts/fixtures/headlamp/package.json",
          import.meta.url
        ),
        "utf8"
      )
    );
    for (const [name, version] of Object.entries(TOOL_VERSIONS)) {
      if (name !== "typescript")
        expect(
          fixture.dependencies[name] ?? fixture.devDependencies[name]
        ).toBe(version);
    }
    for (const name of ["dagre", "graphlib", "lodash"])
      expect(
        fixture.dependencies[name] ?? fixture.devDependencies[name]
      ).toBeUndefined();
  });

  it("hashes exact candidate bytes for receipts", () => {
    expect(hash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    expect(hash("abc\n")).not.toBe(hash("abc"));
  });

  it("allows repository-contained output and rejects escape paths", () => {
    const root = resolve("qualification");
    expect(containedPath(root, resolve(root, "receipts"))).toBe(
      resolve(root, "receipts")
    );
    expect(() => containedPath(root, root)).toThrow("inside the repository");
    expect(() => containedPath(root, resolve(root, "..", "elsewhere"))).toThrow(
      "inside the repository"
    );
  });

  it("makes the negative CSS case by removing only the actual public CSS import", () => {
    const source =
      'import "@radius-project/graph-react/styles.css";\nrenderRealGraph();';
    expect(withoutCandidateStyles(source)).toBe("\nrenderRealGraph();");
    expect(() => withoutCandidateStyles("renderRealGraph();")).toThrow(
      "one candidate CSS import"
    );
    expect(() => withoutCandidateStyles(source + source)).toThrow(
      "one candidate CSS import"
    );
  });

  it("accepts confined npm package entries", () => {
    expect(() =>
      validateTarEntries(["package/package.json", "package/dist/index.js"])
    ).not.toThrow();
  });

  it.each(["SymbolicLink", "Link", "CharacterDevice", "BlockDevice"])(
    "rejects candidate tar entries of type %s before extraction",
    (type) => {
      expect(() => validateTarEntries(["package/dist/link"], [type])).toThrow(
        "links or devices"
      );
    }
  );

  it("requires matching metadata for each tar entry", () => {
    expect(() => validateTarEntries(["package/package.json"], [])).toThrow(
      "Every tar entry"
    );
  });

  it.each([
    [],
    ["../package/a"],
    ["package/../a"],
    ["package\\dist\\a"],
    ["/package/a"]
  ])("rejects empty or unsafe candidate entries %j", (entries) =>
    expect(() => validateTarEntries(entries)).toThrow()
  );

  it("requires the layout engine to travel inside the candidate", () => {
    const missing = (name) => {
      throw new Error(`Cannot find module '${name}'`);
    };
    expect(() =>
      validateBundledLayout(missing, { "@xyflow/react": "12.11.6" })
    ).not.toThrow();
    expect(() => validateBundledLayout(missing)).not.toThrow();
  });

  it.each(["dagre", "graphlib", "lodash"])(
    "rejects a candidate that declares %s as a consumer dependency",
    (name) => {
      expect(() =>
        validateBundledLayout(
          () => {
            throw new Error("Cannot find module");
          },
          { [name]: "1.0.0" }
        )
      ).toThrow(`must bundle ${name} rather than declare it`);
    }
  );

  it.each(["dagre", "graphlib"])(
    "rejects a candidate that resolves a host copy of %s",
    (name) => {
      expect(() =>
        validateBundledLayout((request) => {
          if (request !== name) throw new Error("Cannot find module");
          return `/host/node_modules/${request}`;
        })
      ).toThrow(`must bundle ${name} instead of resolving a host copy`);
    }
  );

  it("requires every sampled host graph property to stay unchanged", () => {
    const before = { ".react-flow__node": [{ width: "150px" }] };
    expect(() =>
      validateHostSample(before, before, "loaded with")
    ).not.toThrow();
    expect(() =>
      validateHostSample(
        before,
        { ".react-flow__node": [{ width: "220px" }] },
        "loaded after"
      )
    ).toThrow(/loaded after the host changed the real Headlamp Flow 12 graph/);
  });

  it("requires independently measured Flow 12 controls to remain unchanged", () => {
    expect(() =>
      validatePeerStyles([{ width: "26px" }], [{ width: "26px" }])
    ).not.toThrow();
    expect(() =>
      validatePeerStyles([{ width: "26px" }], [{ width: "16px" }])
    ).toThrow("Headlamp Flow 12");
  });

  it("accepts real finite non-overlapping card geometry", () => {
    expect(() =>
      validateCardGeometry([card, { ...card, top: 198, bottom: 316 }])
    ).not.toThrow();
    expect(() =>
      validateCardGeometry([card, { ...card, left: 250, right: 470 }])
    ).not.toThrow();
  });

  it.each([
    ["missing CSS", [{ ...card, cssWidth: "180px" }, card]],
    ["missing node", [card]],
    ["non-finite edge", [card, { ...card, left: NaN }]],
    ["hidden card", [{ ...card, width: 0 }, card]],
    ["overlapping cards", [card, card]]
  ])("faithfully fails %s", (_reason, cards) => {
    expect(() => validateCardGeometry(cards)).toThrow();
  });
});
