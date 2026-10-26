import { describe, expect, it, vi } from "vitest";
import {
  AWS_NO_PRIVATE_ZONES_NOTE,
  AWS_OTHER_VPC_WARNING,
  AWS_PUBLIC_SUBNET_WARNING,
  AWS_SUBNET_NOTE,
  AWS_SUBNET_ZONES_ERROR,
  awsInfrastructureWarnings,
  awsSubnetSelectionError,
  defaultAwsSubnetIds,
  initializeAwsInfrastructure,
  parseAwsClusterInfo,
  parseAwsSubnetInfo,
  type AwsSubnetInfo
} from "./aws-infrastructure.js";
import { beginEntry } from "../lifecycle.js";
import {
  createFakeBrowser,
  createFakeElement,
  createFakeSelect,
  type FakeElement
} from "../../../test/support/browser/fakes.js";

const subnets: AwsSubnetInfo[] = [
  {
    id: "subnet-a",
    name: "",
    vpcId: "vpc-1",
    availabilityZone: "us-west-2a",
    public: false
  },
  {
    id: "subnet-b",
    name: "private-b",
    vpcId: "vpc-1",
    availabilityZone: "us-west-2b",
    public: false
  },
  {
    id: "subnet-pub",
    name: "",
    vpcId: "vpc-1",
    availabilityZone: "us-west-2a",
    public: true
  },
  {
    id: "subnet-c",
    name: "",
    vpcId: "vpc-2",
    availabilityZone: "us-west-2c",
    public: false
  }
];

describe("AWS infrastructure rules", () => {
  it("parses discovered clusters and subnets, skipping entries without ids", () => {
    expect(
      parseAwsClusterInfo([
        { id: "c1", vpcId: "vpc-1", authenticationMode: "API" },
        { id: "c2", usable: false },
        { name: "no id" },
        "junk"
      ])
    ).toEqual([
      { id: "c1", vpcId: "vpc-1", authenticationMode: "API", usable: true },
      { id: "c2", vpcId: "", authenticationMode: "", usable: false }
    ]);
    expect(
      parseAwsSubnetInfo([{ id: "s", public: true }, { public: true }])
    ).toEqual([
      { id: "s", name: "", vpcId: "", availabilityZone: "", public: true }
    ]);
  });

  it("selects private subnets only when they span two zones", () => {
    expect(defaultAwsSubnetIds(subnets, "vpc-1")).toEqual([
      "subnet-a",
      "subnet-b"
    ]);
    expect(defaultAwsSubnetIds(subnets, "vpc-2")).toEqual([]);
  });

  it.each([
    [[], AWS_SUBNET_ZONES_ERROR],
    [["subnet-a", "subnet-pub"], AWS_SUBNET_ZONES_ERROR],
    [["subnet-a", "subnet-b"], ""]
  ])("requires two zones for %j", (selected, error) => {
    expect(awsSubnetSelectionError(subnets, selected)).toBe(error);
  });

  it("warns about another VPC and public subnets", () => {
    expect(
      awsInfrastructureWarnings({
        subnets,
        selected: ["subnet-pub"],
        vpcId: "vpc-2",
        clusterVpcId: "vpc-1"
      })
    ).toEqual([AWS_OTHER_VPC_WARNING, AWS_PUBLIC_SUBNET_WARNING]);
    expect(
      awsInfrastructureWarnings({
        subnets,
        selected: ["subnet-a"],
        vpcId: "vpc-1",
        clusterVpcId: ""
      })
    ).toEqual([]);
  });
});

function page() {
  const browser = createFakeBrowser();
  const cluster = createFakeSelect("aws-cluster-select");
  cluster.setOptions([{ value: "shop" }, { value: "other" }]);
  const vpc = createFakeSelect("aws-vpc-select");
  vpc.setOptions([{ value: "vpc-1" }, { value: "vpc-2" }]);
  vpc.value = "vpc-2";
  const elements: Record<string, FakeElement> = {
    list: createFakeElement("aws-subnets-list"),
    error: createFakeElement("aws-subnets-error"),
    note: createFakeElement("aws-subnets-note"),
    warning: createFakeElement("aws-infra-warning")
  };
  for (const element of [cluster, vpc, ...Object.values(elements)]) {
    browser.document.add(element);
  }
  const scope = beginEntry(browser.context, "aws-infra-test");
  if (!scope) throw new Error("Expected an entry scope.");
  const onChange = vi.fn();
  const handle = initializeAwsInfrastructure(browser.context, scope, onChange);
  const boxes = () =>
    elements.list.children.flatMap((row) =>
      row.children.filter((child) => child.tagName === "input")
    );
  return { browser, cluster, vpc, elements, handle, onChange, boxes, scope };
}

describe("initializeAwsInfrastructure", () => {
  it("is invalid until discovery lands", () => {
    const { handle } = page();
    expect(handle.validationError()).toBe(AWS_SUBNET_ZONES_ERROR);
  });

  it("follows the cluster's VPC and checks its private subnets", () => {
    const { handle, vpc, boxes, elements, onChange } = page();
    handle.setDiscovered(
      [{ id: "shop", vpcId: "vpc-1", authenticationMode: "API", usable: true }],
      subnets
    );
    expect(vpc.value).toBe("vpc-1");
    expect(handle.selectedSubnetIds()).toEqual(["subnet-a", "subnet-b"]);
    expect(boxes().map((box) => box.getAttribute("value"))).toEqual([
      "subnet-a",
      "subnet-b",
      "subnet-pub"
    ]);
    expect(boxes().map((box) => box.getAttribute("checked"))).toEqual([
      "checked",
      "checked",
      null
    ]);
    expect(elements.error.hidden).toBe(true);
    expect(elements.note.textContent).toBe(AWS_SUBNET_NOTE);
    expect(elements.warning.hidden).toBe(true);
    expect(handle.validationError()).toBe("");
    expect(onChange).toHaveBeenCalled();
  });

  it("shows the zone error and the public warning as subnets change", () => {
    const { handle, boxes, elements } = page();
    handle.setDiscovered(
      [{ id: "shop", vpcId: "vpc-1", authenticationMode: "API", usable: true }],
      subnets
    );
    const [first, second, publicBox] = boxes();
    Object.assign(second, { checked: false });
    second.dispatch("change");
    expect(handle.selectedSubnetIds()).toEqual(["subnet-a"]);
    expect(elements.error.hidden).toBe(false);
    expect(elements.error.textContent).toBe(AWS_SUBNET_ZONES_ERROR);
    expect(elements.list.getAttribute("aria-invalid")).toBe("true");
    Object.assign(publicBox, { checked: true });
    publicBox.dispatch("change");
    expect(elements.warning.textContent).toBe(AWS_PUBLIC_SUBNET_WARNING);
    expect(handle.validationError()).toBe(AWS_SUBNET_ZONES_ERROR);
    Object.assign(first, { checked: true });
    first.dispatch("change");
    expect(handle.selectedSubnetIds()).toEqual(["subnet-pub", "subnet-a"]);
  });

  it("warns on another VPC and says when its private subnets do not span two zones", () => {
    const { handle, vpc, elements } = page();
    handle.setDiscovered(
      [{ id: "shop", vpcId: "vpc-1", authenticationMode: "API", usable: true }],
      subnets
    );
    vpc.value = "vpc-2";
    vpc.dispatch("change");
    expect(handle.selectedSubnetIds()).toEqual([]);
    expect(elements.note.textContent).toBe(AWS_NO_PRIVATE_ZONES_NOTE);
    expect(elements.warning.textContent).toBe(AWS_OTHER_VPC_WARNING);
  });

  it("follows a newly selected cluster and lists nothing without a VPC", () => {
    const { handle, cluster, vpc, elements } = page();
    handle.setDiscovered(
      [
        { id: "shop", vpcId: "vpc-1", authenticationMode: "API", usable: true },
        { id: "other", vpcId: "", authenticationMode: "API", usable: true }
      ],
      subnets
    );
    vpc.value = "";
    cluster.value = "other";
    cluster.dispatch("change");
    expect(elements.list.children[0]?.textContent).toBe(
      "Select a VPC to list its subnets."
    );
    vpc.value = "vpc-9";
    vpc.dispatch("change");
    expect(elements.list.children[0]?.textContent).toBe(
      "This VPC has no subnets."
    );
  });

  it("keeps the zone error hidden for a restore that lands before discovery", () => {
    const { handle, elements } = page();
    handle.restore("vpc-1", ["subnet-a"]);
    expect(elements.error.hidden).toBe(true);
    expect(handle.validationError()).toBe(AWS_SUBNET_ZONES_ERROR);
  });

  it("restores a saved selection", () => {
    const { handle, vpc } = page();
    handle.setDiscovered([], subnets);
    handle.restore("vpc-1", ["subnet-a", "subnet-pub"]);
    expect(vpc.value).toBe("vpc-1");
    expect(handle.selectedSubnetIds()).toEqual(["subnet-a", "subnet-pub"]);
    handle.restore("", []);
    expect(vpc.value).toBe("vpc-1");
  });
});
