import { describe, expect, it, vi } from "vitest";
import {
  AWS_CLUSTER_REQUIRED_ERROR,
  AWS_NO_CLUSTER_SUBNETS_TEXT,
  AWS_NO_CLUSTER_VPC_TEXT,
  AWS_NO_PRIVATE_ZONES_NOTE,
  AWS_NO_SUBNETS_TEXT,
  AWS_PUBLIC_SUBNET_WARNING,
  AWS_ROUTING_DENIED_WARNING,
  AWS_ROUTING_UNREAD_WARNING,
  AWS_SUBNET_NOTE,
  AWS_SUBNET_ZONES_ERROR,
  AWS_SUBNETS_UNAVAILABLE_ERROR,
  AWS_SUBNETS_UNAVAILABLE_TEXT,
  AWS_UNUSABLE_SUBNET_ERROR,
  AWS_VPC_DENIED_NOTE,
  AWS_VPC_UNREAD_NOTE,
  awsClusterPresentation,
  awsInfrastructureWarnings,
  awsMissingClusterNoteLine,
  awsSubnetSelectionError,
  initializeAwsInfrastructure,
  parseAwsClusterInfo,
  parseAwsSubnetInfo,
  parseAwsVpcInfo,
  readAwsCliErrorKind,
  readAwsErrorKinds,
  type AwsClusterInfo,
  type AwsDiscovered,
  type AwsSubnetInfo
} from "./aws-infrastructure.js";
import { beginEntry } from "../lifecycle.js";
import {
  createFakeBrowser,
  createFakeElement,
  createFakeSelect,
  type FakeElement
} from "../../../test/support/browser/fakes.js";

function subnet(
  id: string,
  vpcId: string,
  availabilityZone: string,
  routing: AwsSubnetInfo["routing"] = "private",
  zoneKind: AwsSubnetInfo["zoneKind"] = "standard",
  name = ""
): AwsSubnetInfo {
  return { id, name, vpcId, availabilityZone, routing, zoneKind };
}

const subnets: AwsSubnetInfo[] = [
  subnet("subnet-a", "vpc-1", "us-west-2a"),
  subnet("subnet-b", "vpc-1", "us-west-2b", "private", "standard", "private-b"),
  subnet("subnet-pub", "vpc-1", "us-west-2a", "public"),
  subnet("subnet-lz", "vpc-1", "us-west-2-lax-1a", "private", "local-zone"),
  subnet(
    "subnet-wl",
    "vpc-1",
    "us-west-2-wl1-sea-wlz-1",
    "private",
    "wavelength-zone"
  ),
  subnet("subnet-op", "vpc-1", "us-west-2a", "private", "outpost"),
  subnet("subnet-c", "vpc-2", "us-west-2c"),
  subnet("subnet-d", "vpc-2", "us-west-2d", "public")
];

function cluster(
  id: string,
  vpcId: string,
  overrides: Partial<AwsClusterInfo> = {}
): AwsClusterInfo {
  return {
    id,
    name: id,
    vpcId,
    authenticationMode: "API",
    status: "ACTIVE",
    usable: true,
    unusableReason: "",
    describeErrorKind: "",
    ...overrides
  };
}

const clusters: AwsClusterInfo[] = [
  cluster("shop", "vpc-1"),
  cluster("other", "vpc-2"),
  cluster("empty", "vpc-3"),
  cluster("legacy", "vpc-1", {
    authenticationMode: "CONFIG_MAP",
    usable: false,
    unusableReason: "config-map"
  })
];

function discovery(overrides: Partial<AwsDiscovered> = {}): AwsDiscovered {
  return {
    clusters,
    subnets,
    vpcs: [{ id: "vpc-1", name: "shop-vpc (vpc-1)" }],
    subnetsErrorKind: "",
    routeTablesErrorKind: "",
    vpcsErrorKind: "",
    ...overrides
  };
}

describe("AWS infrastructure rules", () => {
  it("parses the discovered cluster fields, skipping entries without ids", () => {
    expect(
      parseAwsClusterInfo([
        {
          id: "c1",
          name: "c1",
          vpcId: "vpc-1",
          authenticationMode: "API",
          status: "ACTIVE",
          usable: true,
          unusableReason: "status"
        },
        {
          id: "c2",
          status: "DELETING",
          usable: false,
          unusableReason: "status"
        },
        { id: "c3", usable: false, describeErrorKind: "denied" },
        { id: "c4", unusableReason: "config-map", describeErrorKind: "bogus" },
        { name: "no id" },
        "junk"
      ])
    ).toEqual([
      cluster("c1", "vpc-1"),
      cluster("c2", "", {
        authenticationMode: "",
        status: "DELETING",
        usable: false,
        unusableReason: "status"
      }),
      cluster("c3", "", {
        authenticationMode: "",
        status: "",
        usable: false,
        unusableReason: "not-described",
        describeErrorKind: "denied"
      }),
      cluster("c4", "", {
        authenticationMode: "",
        status: "",
        usable: false,
        unusableReason: "config-map",
        describeErrorKind: "other"
      })
    ]);
  });

  it("maps unknown routing to unknown and drops subnets with an unknown zone kind", () => {
    expect(
      parseAwsSubnetInfo([
        {
          id: "s1",
          name: "one",
          vpcId: "vpc-1",
          availabilityZone: "us-west-2a",
          routing: "public",
          zoneKind: "standard"
        },
        { id: "s2", routing: "private", zoneKind: "outpost" },
        { id: "s3", routing: "transit", zoneKind: "local-zone" },
        { id: "s4", routing: "public", zoneKind: "space-zone" },
        { id: "s5" },
        { routing: "public", zoneKind: "standard" },
        "junk"
      ])
    ).toEqual([
      subnet("s1", "vpc-1", "us-west-2a", "public", "standard", "one"),
      subnet("s2", "", "", "private", "outpost"),
      subnet("s3", "", "", "unknown", "local-zone")
    ]);
  });

  it("parses VPCs and error kinds", () => {
    expect(
      parseAwsVpcInfo([{ id: "vpc-1", name: "lab" }, { id: "vpc-2" }, {}, 3])
    ).toEqual([
      { id: "vpc-1", name: "lab" },
      { id: "vpc-2", name: "" }
    ]);
    expect(readAwsCliErrorKind("credentials")).toBe("credentials");
    expect(readAwsCliErrorKind("expired")).toBe("other");
    expect(readAwsCliErrorKind("")).toBe("");
    expect(
      readAwsErrorKinds({
        subnets: "denied",
        routeTables: "throttled",
        vpcs: "",
        clusters: 3
      })
    ).toEqual({ subnets: "denied", routeTables: "other", vpcs: "other" });
    expect(readAwsErrorKinds(["denied"])).toEqual({});
  });

  it("labels each cluster with the reason it can't be used", () => {
    expect(
      [
        cluster("shop", "vpc-1"),
        cluster("legacy-cluster", "vpc-1", {
          usable: false,
          unusableReason: "config-map"
        }),
        cluster("old-cluster", "vpc-1", {
          status: "DELETING",
          usable: false,
          unusableReason: "status"
        }),
        cluster("locked-cluster", "", {
          usable: false,
          unusableReason: "not-described"
        })
      ].map((item) => awsClusterPresentation(item, "us-west-2").label)
    ).toEqual([
      "shop",
      "legacy-cluster (CONFIG_MAP authentication)",
      "old-cluster (DELETING)",
      "locked-cluster (details unavailable)"
    ]);
  });

  it("writes a note line for each reason a cluster can't be used", () => {
    const awsClusterNoteLine = (item: AwsClusterInfo, region: string) =>
      awsClusterPresentation(item, region).note;
    const locked = (
      describeErrorKind: AwsClusterInfo["describeErrorKind"]
    ): AwsClusterInfo =>
      cluster("locked-cluster", "", {
        usable: false,
        unusableReason: "not-described",
        describeErrorKind
      });
    expect(awsClusterNoteLine(cluster("shop", "vpc-1"), "us-west-2")).toBe(
      null
    );
    expect(
      awsClusterNoteLine(
        cluster("legacy-cluster", "vpc-1", {
          usable: false,
          unusableReason: "config-map"
        }),
        "us-west-2"
      )
    ).toEqual({
      text: "legacy-cluster uses CONFIG_MAP authentication, which doesn't support access entries. A cluster administrator can enable access entries with this command. After that, AWS doesn't allow a switch back to CONFIG_MAP.",
      command:
        "aws eks update-cluster-config --name legacy-cluster --region us-west-2 --access-config authenticationMode=API_AND_CONFIG_MAP"
    });
    expect(
      awsClusterNoteLine(
        cluster("old-cluster", "vpc-1", {
          status: "DELETING",
          usable: false,
          unusableReason: "status"
        }),
        "us-west-2"
      )
    ).toEqual({
      text: "old-cluster is DELETING. Radius can use a cluster that is ACTIVE or UPDATING."
    });
    expect(awsClusterNoteLine(locked("denied"), "us-west-2")).toEqual({
      text: "The signed-in identity can't read locked-cluster (eks:DescribeCluster)."
    });
    expect(awsClusterNoteLine(locked("credentials"), "us-west-2")).toEqual({
      text: "The AWS CLI session ended before locked-cluster could be read. Sign in, then select Refresh."
    });
    for (const kind of ["other", "rejected", ""] as const) {
      expect(awsClusterNoteLine(locked(kind), "us-west-2")).toEqual({
        text: "AWS didn't return the details of locked-cluster. Select Refresh to try again."
      });
    }
    expect(awsMissingClusterNoteLine("old-cluster", "us-east-2")).toEqual({
      text: "The saved cluster old-cluster wasn't found in us-east-2."
    });
  });

  it.each([
    [[], AWS_SUBNET_ZONES_ERROR],
    [["subnet-a", "subnet-pub"], AWS_SUBNET_ZONES_ERROR],
    [["subnet-a", "subnet-lz"], AWS_UNUSABLE_SUBNET_ERROR],
    [["subnet-a", "subnet-b", "subnet-c"], AWS_UNUSABLE_SUBNET_ERROR],
    [["subnet-a", "subnet-gone"], AWS_UNUSABLE_SUBNET_ERROR],
    [["subnet-a", "subnet-b"], ""]
  ])("checks the selection %j", (selected, error) => {
    expect(awsSubnetSelectionError(subnets, "vpc-1", selected)).toBe(error);
  });

  it("warns about unknown routing or a checked public subnet", () => {
    const vpc1 = subnets.filter((entry) => entry.vpcId === "vpc-1");
    expect(
      awsInfrastructureWarnings({
        subnets: vpc1,
        selected: [],
        routeTablesErrorKind: "denied"
      })
    ).toEqual([AWS_ROUTING_DENIED_WARNING]);
    expect(
      awsInfrastructureWarnings({
        subnets: vpc1,
        selected: [],
        routeTablesErrorKind: "other"
      })
    ).toEqual([AWS_ROUTING_UNREAD_WARNING]);
    expect(
      awsInfrastructureWarnings({
        subnets: [],
        selected: [],
        routeTablesErrorKind: "denied"
      })
    ).toEqual([]);
    expect(
      awsInfrastructureWarnings({
        subnets: vpc1,
        selected: ["subnet-pub"],
        routeTablesErrorKind: ""
      })
    ).toEqual([AWS_PUBLIC_SUBNET_WARNING]);
    expect(
      awsInfrastructureWarnings({
        subnets: vpc1,
        selected: ["subnet-a"],
        routeTablesErrorKind: ""
      })
    ).toEqual([]);
  });
});

function page(omit: readonly string[] = []) {
  const browser = createFakeBrowser();
  const select = createFakeSelect("aws-cluster-select");
  select.setOptions([
    { value: "" },
    ...clusters.map((entry) => ({ value: entry.id }))
  ]);
  const elements: Record<string, FakeElement> = {
    vpc: createFakeElement("aws-vpc-value", "output"),
    vpcNote: createFakeElement("aws-vpc-note"),
    restore: createFakeElement("aws-restore-note"),
    list: createFakeElement("aws-subnets-list"),
    error: createFakeElement("aws-subnets-error"),
    note: createFakeElement("aws-subnets-note"),
    warning: createFakeElement("aws-infra-warning")
  };
  for (const element of [select, ...Object.values(elements)]) {
    if (!omit.includes(element.id)) browser.document.add(element);
  }
  const scope = beginEntry(browser.context, "aws-infra-test");
  if (!scope) throw new Error("Expected an entry scope.");
  const onChange = vi.fn();
  const handle = initializeAwsInfrastructure(browser.context, scope, onChange);
  const rows = () => elements.list.children;
  const boxes = () =>
    rows().flatMap((row) =>
      row.children.filter((child) => child.tagName === "input")
    );
  const box = (id: string) => {
    const found = boxes().find((entry) => entry.getAttribute("value") === id);
    if (!found) throw new Error(`No checkbox for ${id}.`);
    return found;
  };
  const toggle = (id: string, checked: boolean) => {
    const target = box(id);
    Object.assign(target, { checked });
    target.dispatch("change");
  };
  const rowText = (id: string) =>
    (rows().find((row) => row.children.includes(box(id)))?.children ?? [])
      .slice(1)
      .map((child) => child.textContent);
  return {
    browser,
    select,
    elements,
    handle,
    onChange,
    rows,
    boxes,
    box,
    toggle,
    rowText
  };
}

describe("initializeAwsInfrastructure", () => {
  it("has no cluster until one is shown", () => {
    const { handle } = page();
    expect(handle.validationError()).toBe(AWS_CLUSTER_REQUIRED_ERROR);
    expect(handle.vpcId()).toBe("");
    expect(handle.selectedSubnetIds()).toEqual([]);
  });

  it("works on a page without its message elements", () => {
    const { handle, onChange } = page([
      "aws-cluster-select",
      "aws-vpc-value",
      "aws-vpc-note",
      "aws-restore-note",
      "aws-subnets-list",
      "aws-subnets-error",
      "aws-subnets-note",
      "aws-infra-warning"
    ]);
    handle.setDiscovered(discovery());
    handle.showCluster("shop", ["subnet-a"]);
    expect(handle.selectedSubnetIds()).toEqual(["subnet-a"]);
    expect(handle.validationError()).toBe(AWS_SUBNET_ZONES_ERROR);
    expect(onChange).toHaveBeenCalled();
  });

  it("stores a discovery without selecting anything", () => {
    const { handle, select, onChange } = page();
    select.value = "";
    handle.setDiscovered(discovery());
    expect(select.value).toBe("");
    expect(handle.vpcId()).toBe("");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows the cluster VPC and checks its private usable subnets", () => {
    const { handle, select, elements, boxes, rowText, onChange } = page();
    handle.setDiscovered(discovery());
    handle.showCluster("shop", "defaults");
    expect(select.value).toBe("shop");
    expect(handle.vpcId()).toBe("vpc-1");
    expect(elements.vpc.textContent).toBe("shop-vpc (vpc-1)");
    expect(handle.selectedSubnetIds()).toEqual(["subnet-a", "subnet-b"]);
    expect(boxes().map((entry) => entry.getAttribute("value"))).toEqual([
      "subnet-a",
      "subnet-b",
      "subnet-pub",
      "subnet-lz",
      "subnet-wl",
      "subnet-op"
    ]);
    expect(boxes().map((entry) => entry.getAttribute("checked"))).toEqual([
      "checked",
      "checked",
      null,
      null,
      null,
      null
    ]);
    expect(rowText("subnet-b")).toEqual([
      "subnet-b (private-b)",
      "us-west-2b",
      "private"
    ]);
    expect(rowText("subnet-pub")).toEqual([
      "subnet-pub",
      "us-west-2a",
      "public"
    ]);
    expect(elements.error.hidden).toBe(true);
    expect(elements.list.getAttribute("aria-invalid")).toBe("false");
    expect(elements.note.textContent).toBe(AWS_SUBNET_NOTE);
    expect(elements.restore.hidden).toBe(true);
    expect(elements.warning.hidden).toBe(true);
    expect(handle.validationError()).toBe("");
    expect(onChange).toHaveBeenCalled();
  });

  it("disables and labels Local Zone, Wavelength Zone, and Outpost subnets", () => {
    const { handle, box, rowText, rows } = page();
    handle.setDiscovered(discovery());
    handle.showCluster("shop", "defaults");
    expect(box("subnet-a").getAttribute("disabled")).toBe(null);
    expect(box("subnet-lz").getAttribute("disabled")).toBe("");
    expect(box("subnet-wl").getAttribute("disabled")).toBe("");
    expect(box("subnet-op").getAttribute("disabled")).toBe("");
    expect(rowText("subnet-lz")[1]).toBe("us-west-2-lax-1a (Local Zone)");
    expect(rowText("subnet-wl")[1]).toBe(
      "us-west-2-wl1-sea-wlz-1 (Wavelength Zone)"
    );
    expect(rowText("subnet-op")[1]).toBe("us-west-2a (Outpost)");
    expect(rows()[3]?.getAttribute("style")).toContain("cursor:default");
    expect(rows()[0]?.getAttribute("style")).toContain("cursor:pointer");
  });

  it("fails validation for a selection with a subnet outside a standard zone", () => {
    const { handle, toggle, elements } = page();
    handle.setDiscovered(discovery());
    handle.showCluster("shop", "defaults");
    toggle("subnet-lz", true);
    expect(handle.selectedSubnetIds()).toEqual([
      "subnet-a",
      "subnet-b",
      "subnet-lz"
    ]);
    expect(handle.validationError()).toBe(AWS_UNUSABLE_SUBNET_ERROR);
    expect(elements.error.textContent).toBe(AWS_UNUSABLE_SUBNET_ERROR);
  });

  it("shows the zone error and the public warning as subnets change", () => {
    const { handle, toggle, elements } = page();
    handle.setDiscovered(discovery());
    handle.showCluster("shop", "defaults");
    toggle("subnet-b", false);
    expect(handle.selectedSubnetIds()).toEqual(["subnet-a"]);
    expect(elements.error.hidden).toBe(false);
    expect(elements.error.textContent).toBe(AWS_SUBNET_ZONES_ERROR);
    expect(elements.list.getAttribute("aria-invalid")).toBe("true");
    toggle("subnet-pub", true);
    expect(elements.warning.hidden).toBe(false);
    expect(elements.warning.textContent).toBe(AWS_PUBLIC_SUBNET_WARNING);
    expect(handle.validationError()).toBe(AWS_SUBNET_ZONES_ERROR);
    toggle("subnet-b", true);
    expect(handle.selectedSubnetIds()).toEqual([
      "subnet-a",
      "subnet-pub",
      "subnet-b"
    ]);
    expect(handle.validationError()).toBe("");
  });

  it("follows a cluster change and says when its private subnets do not span two zones", () => {
    const { handle, select, elements } = page();
    handle.setDiscovered(discovery());
    handle.showCluster("shop", ["subnet-a", "subnet-gone"]);
    expect(elements.restore.hidden).toBe(false);
    select.value = "other";
    select.dispatch("change");
    expect(handle.vpcId()).toBe("vpc-2");
    expect(elements.vpc.textContent).toBe("vpc-2");
    expect(handle.selectedSubnetIds()).toEqual([]);
    expect(elements.note.textContent).toBe(AWS_NO_PRIVATE_ZONES_NOTE);
    expect(elements.restore.hidden).toBe(true);
    expect(elements.restore.textContent).toBe("");
  });

  it("says when the cluster VPC has only public subnets", () => {
    const { handle, elements } = page();
    handle.setDiscovered(
      discovery({
        clusters: [cluster("edge", "vpc-4")],
        subnets: [
          subnet("subnet-p1", "vpc-4", "us-west-2a", "public"),
          subnet("subnet-p2", "vpc-4", "us-west-2b", "public")
        ]
      })
    );
    handle.showCluster("edge", "defaults");
    expect(handle.selectedSubnetIds()).toEqual([]);
    expect(elements.note.textContent).toBe(AWS_NO_PRIVATE_ZONES_NOTE);
  });

  it("leaves the zone note to the routing warning when route tables can't be read", () => {
    const { handle, elements } = page();
    handle.setDiscovered(
      discovery({
        subnets: [
          subnet("subnet-a", "vpc-1", "us-west-2a", "unknown"),
          subnet("subnet-b", "vpc-1", "us-west-2b", "unknown")
        ],
        routeTablesErrorKind: "denied"
      })
    );
    handle.showCluster("shop", "defaults");
    expect(handle.selectedSubnetIds()).toEqual([]);
    expect(elements.note.textContent).toBe(AWS_SUBNET_NOTE);
    expect(elements.warning.textContent).toBe(AWS_ROUTING_DENIED_WARNING);
  });

  it.each([
    ["denied", AWS_VPC_DENIED_NOTE],
    ["other", AWS_VPC_UNREAD_NOTE]
  ] as const)(
    "shows the VPC ID with a note when the VPC read is %s",
    (kind, text) => {
      const { handle, elements } = page();
      handle.setDiscovered(discovery({ vpcs: [], vpcsErrorKind: kind }));
      handle.showCluster("shop", "defaults");
      expect(elements.vpc.textContent).toBe("vpc-1");
      expect(elements.vpcNote.hidden).toBe(false);
      expect(elements.vpcNote.textContent).toBe(text);

      handle.showCluster("", "defaults");
      expect(elements.vpcNote.hidden).toBe(true);
    }
  );

  it("hides the VPC note when the VPCs are read", () => {
    const { handle, elements } = page();
    handle.setDiscovered(discovery());
    handle.showCluster("shop", "defaults");
    expect(elements.vpcNote.hidden).toBe(true);
    expect(elements.vpcNote.textContent).toBe("");
  });

  it("says when the cluster VPC has no subnets", () => {
    const { handle, elements } = page();
    handle.setDiscovered(discovery());
    handle.showCluster("empty", "defaults");
    expect(elements.list.children.map((child) => child.textContent)).toEqual([
      AWS_NO_SUBNETS_TEXT
    ]);
    expect(elements.note.textContent).toBe(AWS_SUBNET_NOTE);
    expect(handle.validationError()).toBe(AWS_SUBNET_ZONES_ERROR);
  });

  it("restores only the usable saved subnets and names each one it removes", () => {
    const { handle, elements, box } = page();
    handle.setDiscovered(discovery());
    handle.showCluster("shop", [
      "subnet-a",
      "subnet-pub",
      "subnet-a",
      "",
      "subnet-gone",
      "subnet-c",
      "subnet-lz",
      "subnet-op"
    ]);
    expect(handle.selectedSubnetIds()).toEqual(["subnet-a", "subnet-pub"]);
    expect(box("subnet-pub").getAttribute("checked")).toBe("checked");
    expect(box("subnet-b").getAttribute("checked")).toBe(null);
    expect(elements.restore.hidden).toBe(false);
    expect(elements.restore.textContent).toBe(
      "These saved subnets were removed from the selection: subnet-gone (not found in the cluster's VPC), subnet-c (not found in the cluster's VPC), subnet-lz (Local Zone), subnet-op (Outpost)."
    );
    expect(handle.validationError()).toBe(AWS_SUBNET_ZONES_ERROR);
    expect(elements.warning.textContent).toBe(AWS_PUBLIC_SUBNET_WARNING);
  });

  it.each([[""], ["legacy"], ["missing"]])(
    "shows no cluster for %j",
    (clusterId) => {
      const { handle, select, elements, onChange } = page();
      handle.setDiscovered(discovery());
      handle.showCluster("shop", "defaults");
      onChange.mockClear();
      handle.showCluster(clusterId, ["subnet-a", "subnet-b"]);
      expect(select.value).toBe("");
      expect(handle.vpcId()).toBe("");
      expect(elements.vpc.textContent).toBe(AWS_NO_CLUSTER_VPC_TEXT);
      expect(elements.list.children.map((child) => child.textContent)).toEqual([
        AWS_NO_CLUSTER_SUBNETS_TEXT
      ]);
      expect(handle.selectedSubnetIds()).toEqual([]);
      expect(elements.error.hidden).toBe(true);
      expect(elements.restore.hidden).toBe(true);
      expect(handle.validationError()).toBe(AWS_CLUSTER_REQUIRED_ERROR);
      expect(onChange).toHaveBeenCalled();
    }
  );

  it("shows a failed subnet list without naming removed subnets", () => {
    const { handle, elements } = page();
    handle.setDiscovered(
      discovery({ subnets: [], subnetsErrorKind: "denied" })
    );
    handle.showCluster("shop", ["subnet-a", "subnet-b"]);
    expect(handle.vpcId()).toBe("vpc-1");
    expect(elements.vpc.textContent).toBe("shop-vpc (vpc-1)");
    expect(elements.list.children.map((child) => child.textContent)).toEqual([
      AWS_SUBNETS_UNAVAILABLE_TEXT
    ]);
    expect(handle.selectedSubnetIds()).toEqual([]);
    expect(elements.restore.hidden).toBe(true);
    expect(elements.error.hidden).toBe(true);
    expect(elements.warning.hidden).toBe(true);
    expect(handle.validationError()).toBe(AWS_SUBNETS_UNAVAILABLE_ERROR);
    handle.showCluster("shop", "defaults");
    expect(handle.selectedSubnetIds()).toEqual([]);
    expect(handle.validationError()).toBe(AWS_SUBNETS_UNAVAILABLE_ERROR);
  });

  it.each([
    ["denied", AWS_ROUTING_DENIED_WARNING],
    ["other", AWS_ROUTING_UNREAD_WARNING]
  ] as const)(
    "checks nothing when route tables fail with %s",
    (kind, warning) => {
      const { handle, elements, rowText } = page();
      handle.setDiscovered(
        discovery({
          subnets: subnets.map((entry) => ({ ...entry, routing: "unknown" })),
          routeTablesErrorKind: kind
        })
      );
      handle.showCluster("shop", "defaults");
      expect(handle.selectedSubnetIds()).toEqual([]);
      expect(rowText("subnet-a")[2]).toBe("routing unknown");
      expect(elements.note.textContent).toBe(AWS_SUBNET_NOTE);
      expect(elements.warning.hidden).toBe(false);
      expect(elements.warning.textContent).toBe(warning);
    }
  );

  it("forgets the discovery on reset", () => {
    const { handle, elements } = page();
    handle.setDiscovered(discovery());
    handle.showCluster("shop", "defaults");
    handle.reset();
    expect(handle.vpcId()).toBe("");
    expect(handle.selectedSubnetIds()).toEqual([]);
    expect(elements.vpc.textContent).toBe(AWS_NO_CLUSTER_VPC_TEXT);
    handle.showCluster("shop", "defaults");
    expect(handle.vpcId()).toBe("");
  });
});
