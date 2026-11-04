// Pure AWS network discovery rules: turn `aws ec2 describe-*` output into the
// VPC and subnet choices the environment wizard offers, label each subnet's
// routing and zone kind, and choose the default subnet selection.

export interface AwsVpc {
  readonly id: string;
  /** The Name tag and ID, such as "main (vpc-1)", or the ID when there's no Name tag. */
  readonly name: string;
}

/**
 * `public` when the subnet's route table has an active route to an internet
 * gateway, `private` when it does not, and `unknown` when route tables could
 * not be read.
 */
export type AwsSubnetRouting = "public" | "private" | "unknown";

/**
 * The kind of zone a subnet is in. Only `standard` availability zones count
 * toward the zones a managed data service's subnet group must span.
 */
export type AwsZoneKind =
  "standard" | "local-zone" | "wavelength-zone" | "outpost";

export interface AwsSubnet {
  readonly id: string;
  readonly name: string;
  readonly vpcId: string;
  readonly availabilityZone: string;
  readonly routing: AwsSubnetRouting;
  readonly zoneKind: AwsZoneKind;
}

export interface AwsSubnetContext {
  /** `aws ec2 describe-route-tables` output, when discovery could read it. */
  readonly routeTables?: unknown;
  /** Zone name to zone type, from `parseAwsZoneTypes`, when available. */
  readonly zones?: ReadonlyMap<string, string>;
  /** The region the subnets are in, such as `us-west-2`. */
  readonly region: string;
}

/** Managed data services need a subnet group spanning this many zones. */
export const AWS_MINIMUM_SUBNET_ZONES = 2;

const ZONE_KINDS: ReadonlyMap<string, AwsZoneKind> = new Map([
  ["availability-zone", "standard"],
  ["local-zone", "local-zone"],
  ["wavelength-zone", "wavelength-zone"]
]);

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

/** Parse `aws ec2 describe-availability-zones` into zone name to zone type. */
export function parseAwsZoneTypes(output: unknown): Map<string, string> {
  const root = isRecord(output) ? output : {};
  const zones = new Map<string, string>();
  for (const zone of records(root.AvailabilityZones)) {
    const name = text(zone.ZoneName);
    if (name) zones.set(name, text(zone.ZoneType));
  }
  return zones;
}

function routesToInternetGateway(table: Record<string, unknown>): boolean {
  return records(table.Routes).some(
    (route) =>
      text(route.GatewayId).startsWith("igw-") && route.State !== "blackhole"
  );
}

// A subnet with no explicit route table association uses its VPC's main table.
// Without readable route tables, every subnet's routing is unknown.
function subnetRouting(
  routeTablesOutput: unknown
): (subnetId: string, vpcId: string) => AwsSubnetRouting {
  if (
    !isRecord(routeTablesOutput) ||
    !Array.isArray(routeTablesOutput.RouteTables)
  ) {
    return () => "unknown";
  }
  const explicit = new Map<string, boolean>();
  const main = new Map<string, boolean>();
  for (const table of records(routeTablesOutput.RouteTables)) {
    const reachesInternet = routesToInternetGateway(table);
    for (const association of records(table.Associations)) {
      const subnetId = text(association.SubnetId);
      if (subnetId) explicit.set(subnetId, reachesInternet);
      if (association.Main === true) {
        main.set(text(table.VpcId), reachesInternet);
      }
    }
  }
  return (subnetId, vpcId) => {
    const reachesInternet = explicit.get(subnetId) ?? main.get(vpcId);
    if (reachesInternet === undefined) return "unknown";
    return reachesInternet ? "public" : "private";
  };
}

function zoneKind(
  subnet: Record<string, unknown>,
  context: AwsSubnetContext
): AwsZoneKind {
  // AWS reports an Outpost's parent zone in AvailabilityZone, so the zone name
  // alone does not show that a subnet is on an Outpost.
  if (text(subnet.OutpostArn)) return "outpost";
  const zone = text(subnet.AvailabilityZone);
  const known = ZONE_KINDS.get(context.zones?.get(zone) ?? "");
  if (known) return known;
  if (
    zone.length === context.region.length + 1 &&
    zone.startsWith(context.region) &&
    /[a-z]$/.test(zone)
  ) {
    return "standard";
  }
  return zone.includes("-wlz-") ? "wavelength-zone" : "local-zone";
}

/**
 * Parse `aws ec2 describe-subnets`, labeling each subnet's routing from the
 * route tables and its zone kind from the zone types, when each is available.
 */
export function parseAwsSubnets(
  subnetsOutput: unknown,
  context: AwsSubnetContext
): AwsSubnet[] {
  const subnetsRoot = isRecord(subnetsOutput) ? subnetsOutput : {};
  const routing = subnetRouting(context.routeTables);
  return records(subnetsRoot.Subnets)
    .map((subnet) => {
      const id = text(subnet.SubnetId);
      const vpcId = text(subnet.VpcId);
      return {
        id,
        name: nameTag(subnet),
        vpcId,
        availabilityZone: text(subnet.AvailabilityZone),
        routing: routing(id, vpcId),
        zoneKind: zoneKind(subnet, context)
      };
    })
    .filter((subnet) => subnet.id !== "");
}

/** Distinct standard availability zones covered by the chosen subnets. */
export function awsSubnetZones(
  subnets: readonly AwsSubnet[],
  selectedIds: readonly string[]
): string[] {
  const zones = new Set<string>();
  for (const subnet of subnets) {
    if (
      selectedIds.includes(subnet.id) &&
      subnet.zoneKind === "standard" &&
      subnet.availabilityZone
    ) {
      zones.add(subnet.availabilityZone);
    }
  }
  return [...zones].sort();
}

/**
 * The default subnet selection for a VPC: its private subnets in standard
 * zones, but only when they span at least two zones. Otherwise, including when
 * routing is unknown, the selection is left empty rather than guessed.
 */
export function defaultAwsSubnetSelection(
  subnets: readonly AwsSubnet[],
  vpcId: string
): string[] {
  const privateIds = subnets
    .filter(
      (subnet) =>
        subnet.vpcId === vpcId &&
        subnet.routing === "private" &&
        subnet.zoneKind === "standard"
    )
    .map((subnet) => subnet.id);
  return (
      awsSubnetZones(subnets, privateIds).length >= AWS_MINIMUM_SUBNET_ZONES
    ) ?
      privateIds
    : [];
}

const AWS_VPC_ID_PATTERN = /^vpc-[0-9a-f]+$/;
// The deploy workflow checks RADIUS_SUBNET_IDS with the same pattern.
const AWS_SUBNET_IDS_PATTERN = /^subnet-[0-9a-f]+(,subnet-[0-9a-f]+)*$/;

/**
 * True when a setup request has a VPC ID and a comma-separated list of at
 * least two different subnet IDs. This checks the form of the IDs only. It
 * doesn't prove that the subnets exist or that a cluster can use them. Both
 * values must be strings, because an array would pass once converted to one.
 */
export function isAwsSetupNetworkInput(
  vpcId: unknown,
  subnetIds: unknown
): boolean {
  return (
    typeof vpcId === "string" &&
    typeof subnetIds === "string" &&
    AWS_VPC_ID_PATTERN.test(vpcId) &&
    AWS_SUBNET_IDS_PATTERN.test(subnetIds) &&
    new Set(subnetIds.split(",")).size >= 2
  );
}
