import type { ComputePlatform, PortalContext } from "./types.js";

export const aws: ComputePlatform = {
  id: "aws",
  displayName: "AWS",
  clusterServiceName: "EKS",

  portalUrl(resourceType: string, ctx: PortalContext): string {
    const region = ctx.region;
    const awsBase = `https://${region}.console.aws.amazon.com`;

    if (
      resourceType.includes("aws_db_instance") ||
      resourceType.includes("RDS")
    ) {
      return `${awsBase}/rds/home?region=${region}#databases:`;
    }
    if (
      resourceType.includes("aws_secretsmanager") ||
      resourceType.includes("Secrets Manager")
    ) {
      return `${awsBase}/secretsmanager/home?region=${region}#!/listSecrets`;
    }
    if (resourceType.includes("aws_ecr") || resourceType.includes("ECR")) {
      return `${awsBase}/ecr/repositories?region=${region}`;
    }
    if (
      resourceType.includes("aws_lb") ||
      resourceType.includes("Load Balancer")
    ) {
      return `${awsBase}/ec2/home?region=${region}#LoadBalancers:`;
    }
    if (resourceType.includes("aws_ebs") || resourceType.includes("EBS")) {
      return `${awsBase}/ec2/home?region=${region}#Volumes:`;
    }
    if (
      resourceType.includes("aws_security_group") ||
      resourceType.includes("Security Group")
    ) {
      return `${awsBase}/ec2/home?region=${region}#SecurityGroups:`;
    }
    if (
      resourceType.includes("aws_db_subnet") ||
      resourceType.includes("Subnet Group")
    ) {
      return `${awsBase}/rds/home?region=${region}#db-subnet-groups-list:`;
    }
    if (
      resourceType.includes("aws_elasticache") ||
      resourceType.includes("MemoryDB")
    ) {
      return `${awsBase}/memorydb/home?region=${region}#/clusters`;
    }
    // K8s resources link to EKS cluster
    if (
      resourceType.includes("apps/Deployment") ||
      resourceType.includes("core/Service") ||
      resourceType.includes("Ingress") ||
      resourceType.includes("PersistentVolume")
    ) {
      return `${awsBase}/eks/home?region=${region}#/clusters`;
    }
    return "";
  }
};
