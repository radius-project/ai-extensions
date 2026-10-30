import { describe, expect, it } from "vitest";
import {
  awsSubnetZones,
  defaultAwsSubnetSelection,
  parseAwsSubnets,
  parseAwsVpcs
} from "./aws-network.js";

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
      Routes: [{ GatewayId: "igw-1" }]
    },
    {
      VpcId: "vpc-2",
      Associations: [{ Main: true }],
      Routes: [{ GatewayId: "igw-2" }]
    }
  ]
};

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

describe("parseAwsSubnets", () => {
  it("labels a subnet public only when its route table reaches an internet gateway", () => {
    const subnets = parseAwsSubnets(subnetsOutput, routeTablesOutput);
    expect(subnets.map((subnet) => [subnet.id, subnet.public])).toEqual([
      ["subnet-a", false],
      ["subnet-b", false],
      ["subnet-pub", true],
      ["subnet-main", true]
    ]);
    expect(subnets[0]).toMatchObject({
      name: "private-a",
      availabilityZone: "us-west-2a",
      vpcId: "vpc-1"
    });
  });

  it("treats a subnet with no route table information as private", () => {
    expect(parseAwsSubnets(subnetsOutput, undefined)[2].public).toBe(false);
  });
});

describe("subnet selection", () => {
  const subnets = parseAwsSubnets(subnetsOutput, routeTablesOutput);

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
});
