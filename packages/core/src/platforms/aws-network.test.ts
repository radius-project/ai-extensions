import { describe, expect, it } from "vitest";
import {
  awsSubnetZones,
  defaultAwsSubnetSelection,
  isAwsSetupNetworkInput,
  parseAwsSubnets,
  parseAwsVpcs,
  parseAwsZoneTypes,
  type AwsSubnet
} from "./aws-network.js";

const region = "us-west-2";

const subnetsOutput = {
  Subnets: [
    {
      SubnetId: "subnet-a",
      VpcId: "vpc-1",
      AvailabilityZone: "us-west-2a",
      Tags: [{ Key: "Name", Value: "private-a" }]
    },
    { SubnetId: "subnet-b", VpcId: "vpc-1", AvailabilityZone: "us-west-2b" },
    { SubnetId: "subnet-pub", VpcId: "vpc-1", AvailabilityZone: "us-west-2a" },
    { SubnetId: "subnet-main", VpcId: "vpc-2", AvailabilityZone: "us-west-2c" },
    { VpcId: "vpc-2" }
  ]
};

const routeTablesOutput = {
  RouteTables: [
    {
      VpcId: "vpc-1",
      Associations: [{ Main: true }, { SubnetId: "subnet-a" }],
      Routes: [{ GatewayId: "local" }, { NatGatewayId: "nat-1" }]
    },
    {
      VpcId: "vpc-1",
      Associations: [{ SubnetId: "subnet-pub" }],
      Routes: [{ GatewayId: "igw-1", State: "active" }]
    },
    {
      VpcId: "vpc-2",
      Associations: [{ Main: true }],
      Routes: [{ GatewayId: "igw-2" }]
    }
  ]
};

function subnet(
  id: string,
  availabilityZone: string,
  overrides: Partial<AwsSubnet> = {}
): AwsSubnet {
  return {
    id,
    name: "",
    vpcId: "vpc-1",
    availabilityZone,
    routing: "private",
    zoneKind: "standard",
    ...overrides
  };
}

describe("parseAwsVpcs", () => {
  it("labels VPCs with their Name tag", () => {
    expect(
      parseAwsVpcs({
        Vpcs: [
          { VpcId: "vpc-1", Tags: [{ Key: "Name", Value: "main" }] },
          { VpcId: "vpc-2" },
          {}
        ]
      })
    ).toEqual([
      { id: "vpc-1", name: "main (vpc-1)" },
      { id: "vpc-2", name: "vpc-2" }
    ]);
    expect(parseAwsVpcs(null)).toEqual([]);
  });
});

describe("parseAwsZoneTypes", () => {
  it("maps each zone name to its zone type", () => {
    expect(
      parseAwsZoneTypes({
        AvailabilityZones: [
          { ZoneName: "us-west-2a", ZoneType: "availability-zone" },
          { ZoneName: "us-west-2-lax-1a", ZoneType: "local-zone" },
          { ZoneName: "us-west-2-wl1-sea-wlz-1" },
          { ZoneType: "availability-zone" }
        ]
      })
    ).toEqual(
      new Map([
        ["us-west-2a", "availability-zone"],
        ["us-west-2-lax-1a", "local-zone"],
        ["us-west-2-wl1-sea-wlz-1", ""]
      ])
    );
    expect(parseAwsZoneTypes(null)).toEqual(new Map());
  });
});

describe("parseAwsSubnets routing", () => {
  it("labels a subnet public only when its route table reaches an internet gateway", () => {
    const subnets = parseAwsSubnets(subnetsOutput, {
      routeTables: routeTablesOutput,
      region
    });
    expect(subnets.map((entry) => [entry.id, entry.routing])).toEqual([
      ["subnet-a", "private"],
      ["subnet-b", "private"],
      ["subnet-pub", "public"],
      ["subnet-main", "public"]
    ]);
    expect(subnets[0]).toEqual({
      id: "subnet-a",
      name: "private-a",
      vpcId: "vpc-1",
      availabilityZone: "us-west-2a",
      routing: "private",
      zoneKind: "standard"
    });
  });

  it("treats a blackhole route to an internet gateway as private", () => {
    const [entry] = parseAwsSubnets(
      {
        Subnets: [
          {
            SubnetId: "subnet-a",
            VpcId: "vpc-1",
            AvailabilityZone: "us-west-2a"
          }
        ]
      },
      {
        routeTables: {
          RouteTables: [
            {
              VpcId: "vpc-1",
              Associations: [{ SubnetId: "subnet-a" }],
              Routes: [{ GatewayId: "igw-1", State: "blackhole" }]
            }
          ]
        },
        region
      }
    );
    expect(entry.routing).toBe("private");
  });

  it("lets an explicit route table override a public main table", () => {
    const [entry] = parseAwsSubnets(
      {
        Subnets: [
          {
            SubnetId: "subnet-a",
            VpcId: "vpc-1",
            AvailabilityZone: "us-west-2a"
          }
        ]
      },
      {
        routeTables: {
          RouteTables: [
            {
              VpcId: "vpc-1",
              Associations: [{ Main: true }],
              Routes: [{ GatewayId: "igw-1", State: "active" }]
            },
            {
              VpcId: "vpc-1",
              Associations: [{ SubnetId: "subnet-a" }],
              Routes: [{ GatewayId: "local" }]
            }
          ]
        },
        region
      }
    );
    expect(entry.routing).toBe("private");
  });

  it.each([
    ["no route tables", undefined],
    ["empty CLI output", null],
    ["an answer with no route table list", {}]
  ])("labels every subnet's routing unknown with %s", (_label, routeTables) => {
    const subnets = parseAwsSubnets(subnetsOutput, { routeTables, region });
    expect(subnets.map((entry) => entry.routing)).toEqual([
      "unknown",
      "unknown",
      "unknown",
      "unknown"
    ]);
    expect(defaultAwsSubnetSelection(subnets, "vpc-1")).toEqual([]);
  });

  it("labels a subnet unknown when no route table covers it", () => {
    const [entry] = parseAwsSubnets(
      {
        Subnets: [
          {
            SubnetId: "subnet-other",
            VpcId: "vpc-3",
            AvailabilityZone: "us-west-2a"
          }
        ]
      },
      { routeTables: routeTablesOutput, region }
    );
    expect(entry.routing).toBe("unknown");
  });
});

describe("parseAwsSubnets zone kinds", () => {
  const zones = parseAwsZoneTypes({
    AvailabilityZones: [
      { ZoneName: "us-west-2a", ZoneType: "availability-zone" },
      { ZoneName: "us-west-2b", ZoneType: "availability-zone" },
      { ZoneName: "us-west-2-lax-1a", ZoneType: "local-zone" },
      { ZoneName: "us-west-2-wl1-sea-wlz-1", ZoneType: "wavelength-zone" }
    ]
  });

  function kinds(
    subnets: readonly Record<string, unknown>[],
    zoneTypes?: ReadonlyMap<string, string>
  ): string[] {
    return parseAwsSubnets(
      {
        Subnets: subnets.map((entry, index) => ({
          SubnetId: `subnet-${index}`,
          VpcId: "vpc-1",
          ...entry
        }))
      },
      { routeTables: { RouteTables: [] }, zones: zoneTypes, region }
    ).map((entry) => entry.zoneKind);
  }

  it("reads each zone kind from the zone types", () => {
    expect(
      kinds(
        [
          { AvailabilityZone: "us-west-2a" },
          { AvailabilityZone: "us-west-2-lax-1a" },
          { AvailabilityZone: "us-west-2-wl1-sea-wlz-1" }
        ],
        zones
      )
    ).toEqual(["standard", "local-zone", "wavelength-zone"]);
  });

  it("labels an Outpost subnet in a standard zone as an Outpost", () => {
    expect(
      kinds(
        [
          {
            AvailabilityZone: "us-west-2a",
            OutpostArn:
              "arn:aws:outposts:us-west-2:123456789012:outpost/op-0123456789abcdef0"
          }
        ],
        zones
      )
    ).toEqual(["outpost"]);
  });

  it("reads zone kinds from zone names when the zone types are missing", () => {
    expect(
      kinds([
        { AvailabilityZone: "us-west-2d" },
        { AvailabilityZone: "us-west-2-lax-1a" },
        { AvailabilityZone: "us-west-2-wl1-sea-wlz-1" },
        { AvailabilityZone: "us-east-1a" },
        { AvailabilityZone: "us-west-2ab" },
        { AvailabilityZone: "us-west-21" }
      ])
    ).toEqual([
      "standard",
      "local-zone",
      "wavelength-zone",
      "local-zone",
      "local-zone",
      "local-zone"
    ]);
  });

  it("falls back to the zone name for a zone type it does not recognize", () => {
    expect(
      kinds(
        [
          { AvailabilityZone: "us-west-2c" },
          { AvailabilityZone: "us-west-2-new-1a" },
          { AvailabilityZone: "us-west-2-obj-1a" }
        ],
        new Map([
          ["us-west-2c", "future-zone"],
          ["us-west-2-new-1a", "future-zone"],
          ["us-west-2-obj-1a", "constructor"]
        ])
      )
    ).toEqual(["standard", "local-zone", "local-zone"]);
  });
});

describe("subnet selection", () => {
  const subnets = parseAwsSubnets(subnetsOutput, {
    routeTables: routeTablesOutput,
    region
  });

  it("selects the VPC's private subnets when they span two zones", () => {
    expect(defaultAwsSubnetSelection(subnets, "vpc-1")).toEqual([
      "subnet-a",
      "subnet-b"
    ]);
  });

  it("leaves the selection empty when private subnets span one zone", () => {
    expect(defaultAwsSubnetSelection(subnets, "vpc-2")).toEqual([]);
  });

  it("counts distinct zones in a selection", () => {
    expect(awsSubnetZones(subnets, ["subnet-a", "subnet-pub"])).toEqual([
      "us-west-2a"
    ]);
    expect(awsSubnetZones(subnets, [])).toEqual([]);
  });

  it("counts only standard zones and leaves a Local Zone subnet out of the defaults", () => {
    const mixed = [
      subnet("subnet-a", "us-west-2a"),
      subnet("subnet-b", "us-west-2b"),
      subnet("subnet-lax", "us-west-2-lax-1a", { zoneKind: "local-zone" })
    ];
    expect(
      awsSubnetZones(mixed, ["subnet-a", "subnet-b", "subnet-lax"])
    ).toEqual(["us-west-2a", "us-west-2b"]);
    expect(defaultAwsSubnetSelection(mixed, "vpc-1")).toEqual([
      "subnet-a",
      "subnet-b"
    ]);
  });

  it("selects nothing when private subnets cover one standard zone and a Local Zone", () => {
    const mixed = [
      subnet("subnet-a", "us-west-2a"),
      subnet("subnet-lax", "us-west-2-lax-1a", { zoneKind: "local-zone" }),
      subnet("subnet-pub", "us-west-2b", { routing: "public" })
    ];
    expect(defaultAwsSubnetSelection(mixed, "vpc-1")).toEqual([]);
  });

  it("does not count a standard subnet without a zone name", () => {
    expect(awsSubnetZones([subnet("subnet-a", "")], ["subnet-a"])).toEqual([]);
  });
});

describe("isAwsSetupNetworkInput", () => {
  it("accepts a VPC ID and two or more comma-separated subnet IDs", () => {
    expect(isAwsSetupNetworkInput("vpc-0abc", "subnet-a1,subnet-b2")).toBe(
      true
    );
    expect(isAwsSetupNetworkInput("vpc-1", "subnet-1,subnet-2,subnet-3")).toBe(
      true
    );
  });

  it.each([
    ["one subnet", "vpc-1", "subnet-a"],
    ["the same subnet twice", "vpc-1", "subnet-a,subnet-a"],
    ["a space after a comma", "vpc-1", "subnet-a, subnet-b"],
    ["an uppercase ID", "vpc-1", "subnet-A,subnet-b"],
    ["a VPC name", "shop-vpc", "subnet-a,subnet-b"],
    ["an empty VPC ID", "", "subnet-a,subnet-b"],
    ["subnet IDs as an array", "vpc-1", ["subnet-a", "subnet-b"]],
    ["a VPC ID that isn't a string", 1, "subnet-a,subnet-b"]
  ])("rejects %s", (_label, vpcId, subnetIds) => {
    expect(isAwsSetupNetworkInput(vpcId, subnetIds)).toBe(false);
  });
});
