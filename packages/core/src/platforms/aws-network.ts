// Pure AWS network discovery rules: turn `aws ec2 describe-*` output into the
// VPC and subnet choices the environment wizard offers, label each subnet
// public or private, and choose the default subnet selection.

export interface AwsVpc {
  readonly id: string;
  readonly name: string;
}

export interface AwsSubnet {
  readonly id: string;
  readonly name: string;
  readonly vpcId: string;
  readonly availabilityZone: string;
  /** True when the subnet's route table reaches an internet gateway. */
  readonly public: boolean;
}

/** Managed data services need a subnet group spanning this many zones. */
export const AWS_MINIMUM_SUBNET_ZONES = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nameTag(resource: Record<string, unknown>): string {
  const tag = records(resource.Tags).find((entry) => entry.Key === "Name");
  return tag ? text(tag.Value) : "";
}

/** Parse `aws ec2 describe-vpcs --output json`. */
export function parseAwsVpcs(output: unknown): AwsVpc[] {
  const root = isRecord(output) ? output : {};
  return records(root.Vpcs)
    .map((vpc) => {
      const id = text(vpc.VpcId);
      const name = nameTag(vpc);
      return { id, name: name ? `${name} (${id})` : id };
    })
    .filter((vpc) => vpc.id !== "");
}

function routesToInternetGateway(table: Record<string, unknown>): boolean {
  return records(table.Routes).some((route) =>
    text(route.GatewayId).startsWith("igw-")
  );
}

/**
 * Parse `aws ec2 describe-subnets` and `aws ec2 describe-route-tables`. A
 * subnet with no explicit route table association uses its VPC's main table.
 */
export function parseAwsSubnets(
  subnetsOutput: unknown,
  routeTablesOutput: unknown
): AwsSubnet[] {
  const subnetsRoot = isRecord(subnetsOutput) ? subnetsOutput : {};
  const tablesRoot = isRecord(routeTablesOutput) ? routeTablesOutput : {};
  const explicit = new Map<string, boolean>();
  const main = new Map<string, boolean>();
  for (const table of records(tablesRoot.RouteTables)) {
    const reachesInternet = routesToInternetGateway(table);
    for (const association of records(table.Associations)) {
      const subnetId = text(association.SubnetId);
      if (subnetId) explicit.set(subnetId, reachesInternet);
      if (association.Main === true) {
        main.set(text(table.VpcId), reachesInternet);
      }
    }
  }
  return records(subnetsRoot.Subnets)
    .map((subnet) => {
      const id = text(subnet.SubnetId);
      const vpcId = text(subnet.VpcId);
      return {
        id,
        name: nameTag(subnet),
        vpcId,
        availabilityZone: text(subnet.AvailabilityZone),
        public: explicit.get(id) ?? main.get(vpcId) ?? false
      };
    })
    .filter((subnet) => subnet.id !== "");
}

/** Distinct availability zones covered by the chosen subnets. */
export function awsSubnetZones(
  subnets: readonly AwsSubnet[],
  selectedIds: readonly string[]
): string[] {
  const zones = new Set<string>();
  for (const subnet of subnets) {
    if (selectedIds.includes(subnet.id) && subnet.availabilityZone) {
      zones.add(subnet.availabilityZone);
    }
  }
  return [...zones].sort();
}

/**
 * The default subnet selection for a VPC: its private subnets, but only when
 * they span at least two zones. Otherwise the selection is left empty rather
 * than guessed.
 */
export function defaultAwsSubnetSelection(
  subnets: readonly AwsSubnet[],
  vpcId: string
): string[] {
  const privateIds = subnets
    .filter((subnet) => subnet.vpcId === vpcId && !subnet.public)
    .map((subnet) => subnet.id);
  return (
      awsSubnetZones(subnets, privateIds).length >= AWS_MINIMUM_SUBNET_ZONES
    ) ?
      privateIds
    : [];
}
