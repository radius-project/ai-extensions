import { describe, it, expect } from "vitest";
import { aws } from "./aws.js";

describe("aws platform", () => {
  describe("static properties", () => {
    it("has correct id", () => {
      expect(aws.id).toBe("aws");
    });

    it("has correct displayName", () => {
      expect(aws.displayName).toBe("AWS");
    });

    it("has correct recipePlatform", () => {
      expect(aws.recipePlatform).toBe("aws");
    });

    it("has correct clusterServiceName", () => {
      expect(aws.clusterServiceName).toBe("EKS");
    });

    it("supports oidc and portalUrl", () => {
      expect(aws.supports).toEqual({ oidc: true, portalUrl: true });
    });

    it("has non-empty verifyWorkflowSteps", () => {
      expect(aws.verifyWorkflowSteps).toContain("Configure AWS Credentials");
      expect(aws.verifyWorkflowSteps).toContain("Verify AWS Credentials");
      expect(aws.verifyWorkflowSteps).toContain("Verify EKS Access");
    });

    it("has non-empty deployClusterAuthSteps", () => {
      expect(aws.deployClusterAuthSteps).toContain("Configure AWS Credentials");
      expect(aws.deployClusterAuthSteps).toContain("radius-deployer");
    });

    it("has non-empty radCredentialRegister", () => {
      expect(aws.radCredentialRegister).toContain("rad credential register aws irsa");
    });

    it("has empty recipeAuthEnv", () => {
      expect(aws.recipeAuthEnv).toBe("");
    });

    it("has non-empty dbRecipeRegister", () => {
      expect(aws.dbRecipeRegister).toContain("Radius.Data/mySqlDatabases");
      expect(aws.dbRecipeRegister).toContain("rad recipe register");
    });
  });

  describe("generateOidc", () => {
    it("returns correct message and output with full data", () => {
      const result = aws.generateOidc({ accountId: "123456789012", region: "us-east-1" });
      expect(result.message).toBe("AWS authentication validated");
      expect(result.output).toContain("Account ID: 123456789012");
      expect(result.output).toContain("Region: us-east-1");
      expect(result.output).toContain('gh variable set AWS_ACCOUNT_ID --body "123456789012"');
      expect(result.output).toContain('gh variable set AWS_REGION --body "us-east-1"');
    });

    it("handles missing accountId gracefully", () => {
      const result = aws.generateOidc({ region: "eu-west-1" });
      expect(result.message).toBe("AWS authentication validated");
      expect(result.output).toContain("Account ID: ");
      expect(result.output).toContain("Region: eu-west-1");
      expect(result.output).toContain('gh variable set AWS_ACCOUNT_ID --body ""');
    });

    it("handles missing region gracefully", () => {
      const result = aws.generateOidc({ accountId: "111111111111" });
      expect(result.output).toContain("Account ID: 111111111111");
      expect(result.output).toContain("Region: ");
      expect(result.output).toContain('gh variable set AWS_REGION --body ""');
    });

    it("handles empty data object", () => {
      const result = aws.generateOidc({});
      expect(result.message).toBe("AWS authentication validated");
      expect(result.output).toContain("Account ID: ");
      expect(result.output).toContain("Region: ");
    });
  });

  describe("environmentSecrets", () => {
    it("returns correct secrets with full data", () => {
      const result = aws.environmentSecrets({ accountId: "123456789012", region: "us-west-2" });
      expect(result).toEqual([
        { kind: "variable", name: "AWS_ACCOUNT_ID", value: "123456789012" },
        { kind: "variable", name: "AWS_REGION", value: "us-west-2" },
      ]);
    });

    it("returns undefined values when data is missing fields", () => {
      const result = aws.environmentSecrets({});
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ kind: "variable", name: "AWS_ACCOUNT_ID", value: undefined });
      expect(result[1]).toEqual({ kind: "variable", name: "AWS_REGION", value: undefined });
    });

    it("all entries have kind 'variable'", () => {
      const result = aws.environmentSecrets({ accountId: "x", region: "y" });
      for (const secret of result) {
        expect(secret.kind).toBe("variable");
      }
    });
  });

  describe("portalUrl", () => {
    const ctx = { subscriptionId: "", resourceGroup: "", region: "us-east-1" };

    it("returns RDS URL for aws_db_instance resource type", () => {
      const url = aws.portalUrl("aws_db_instance", ctx);
      expect(url).toBe("https://us-east-1.console.aws.amazon.com/rds/home?region=us-east-1#databases:");
    });

    it("returns RDS URL for RDS resource type", () => {
      const url = aws.portalUrl("RDS", ctx);
      expect(url).toBe("https://us-east-1.console.aws.amazon.com/rds/home?region=us-east-1#databases:");
    });

    it("returns Secrets Manager URL for aws_secretsmanager type", () => {
      const url = aws.portalUrl("aws_secretsmanager_secret", ctx);
      expect(url).toBe("https://us-east-1.console.aws.amazon.com/secretsmanager/home?region=us-east-1#!/listSecrets");
    });

    it("returns Secrets Manager URL for 'Secrets Manager' type", () => {
      const url = aws.portalUrl("Secrets Manager", ctx);
      expect(url).toBe("https://us-east-1.console.aws.amazon.com/secretsmanager/home?region=us-east-1#!/listSecrets");
    });

    it("returns ECR URL for aws_ecr type", () => {
      const url = aws.portalUrl("aws_ecr_repository", ctx);
      expect(url).toBe("https://us-east-1.console.aws.amazon.com/ecr/repositories?region=us-east-1");
    });

    it("returns ECR URL for ECR type", () => {
      const url = aws.portalUrl("ECR", ctx);
      expect(url).toBe("https://us-east-1.console.aws.amazon.com/ecr/repositories?region=us-east-1");
    });

    it("returns Load Balancer URL for aws_lb type", () => {
      const url = aws.portalUrl("aws_lb", ctx);
      expect(url).toBe("https://us-east-1.console.aws.amazon.com/ec2/home?region=us-east-1#LoadBalancers:");
    });

    it("returns Load Balancer URL for 'Load Balancer' type", () => {
      const url = aws.portalUrl("Load Balancer", ctx);
      expect(url).toBe("https://us-east-1.console.aws.amazon.com/ec2/home?region=us-east-1#LoadBalancers:");
    });

    it("returns EBS URL for aws_ebs type", () => {
      const url = aws.portalUrl("aws_ebs_volume", ctx);
      expect(url).toBe("https://us-east-1.console.aws.amazon.com/ec2/home?region=us-east-1#Volumes:");
    });

    it("returns EBS URL for 'EBS' type", () => {
      const url = aws.portalUrl("EBS", ctx);
      expect(url).toBe("https://us-east-1.console.aws.amazon.com/ec2/home?region=us-east-1#Volumes:");
    });

    it("returns Security Group URL for aws_security_group type", () => {
      const url = aws.portalUrl("aws_security_group", ctx);
      expect(url).toBe("https://us-east-1.console.aws.amazon.com/ec2/home?region=us-east-1#SecurityGroups:");
    });

    it("returns Security Group URL for 'Security Group' type", () => {
      const url = aws.portalUrl("Security Group", ctx);
      expect(url).toBe("https://us-east-1.console.aws.amazon.com/ec2/home?region=us-east-1#SecurityGroups:");
    });

    it("returns DB Subnet Group URL for aws_db_subnet type", () => {
      const url = aws.portalUrl("aws_db_subnet_group", ctx);
      expect(url).toBe("https://us-east-1.console.aws.amazon.com/rds/home?region=us-east-1#db-subnet-groups-list:");
    });

    it("returns DB Subnet Group URL for 'Subnet Group' type", () => {
      const url = aws.portalUrl("Subnet Group", ctx);
      expect(url).toBe("https://us-east-1.console.aws.amazon.com/rds/home?region=us-east-1#db-subnet-groups-list:");
    });

    it("returns MemoryDB URL for aws_elasticache type", () => {
      const url = aws.portalUrl("aws_elasticache_cluster", ctx);
      expect(url).toBe("https://us-east-1.console.aws.amazon.com/memorydb/home?region=us-east-1#/clusters");
    });

    it("returns MemoryDB URL for 'MemoryDB' type", () => {
      const url = aws.portalUrl("MemoryDB", ctx);
      expect(url).toBe("https://us-east-1.console.aws.amazon.com/memorydb/home?region=us-east-1#/clusters");
    });

    it("returns EKS URL for apps/Deployment resource type", () => {
      const url = aws.portalUrl("apps/Deployment", ctx);
      expect(url).toBe("https://us-east-1.console.aws.amazon.com/eks/home?region=us-east-1#/clusters");
    });

    it("returns EKS URL for core/Service resource type", () => {
      const url = aws.portalUrl("core/Service", ctx);
      expect(url).toBe("https://us-east-1.console.aws.amazon.com/eks/home?region=us-east-1#/clusters");
    });

    it("returns EKS URL for Ingress resource type", () => {
      const url = aws.portalUrl("Ingress", ctx);
      expect(url).toBe("https://us-east-1.console.aws.amazon.com/eks/home?region=us-east-1#/clusters");
    });

    it("returns EKS URL for PersistentVolume resource type", () => {
      const url = aws.portalUrl("PersistentVolume", ctx);
      expect(url).toBe("https://us-east-1.console.aws.amazon.com/eks/home?region=us-east-1#/clusters");
    });

    it("returns empty string for unknown resource type", () => {
      const url = aws.portalUrl("unknown_resource", ctx);
      expect(url).toBe("");
    });

    it("returns empty string for empty resource type", () => {
      const url = aws.portalUrl("", ctx);
      expect(url).toBe("");
    });

    it("uses region from context in URL", () => {
      const euCtx = { subscriptionId: "", resourceGroup: "", region: "eu-west-2" };
      const url = aws.portalUrl("aws_db_instance", euCtx);
      expect(url).toBe("https://eu-west-2.console.aws.amazon.com/rds/home?region=eu-west-2#databases:");
    });
  });
});
