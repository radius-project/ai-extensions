import { describe, it, expect } from "vitest";
import {
  parseTerraformResources,
  formatTerraformType,
  formatTerraformModule,
} from "./terraform.js";

describe("formatTerraformType", () => {
  it("formats AWS resource types", () => {
    expect(formatTerraformType("aws_db_instance")).toBe("AWS Db Instance");
    expect(formatTerraformType("aws_security_group")).toBe(
      "AWS Security Group",
    );
  });

  it("formats Azure resource types", () => {
    expect(formatTerraformType("azurerm_resource_group")).toBe(
      "Azure Resource Group",
    );
    expect(formatTerraformType("azurerm_virtual_network")).toBe(
      "Azure Virtual Network",
    );
  });

  it("returns the raw type for unknown prefixes", () => {
    expect(formatTerraformType("google_compute_instance")).toBe(
      "google_compute_instance",
    );
    expect(formatTerraformType("custom_resource")).toBe("custom_resource");
  });

  it("handles single-word suffixes after prefix", () => {
    expect(formatTerraformType("aws_vpc")).toBe("AWS Vpc");
    expect(formatTerraformType("azurerm_subnet")).toBe("Azure Subnet");
  });
});

describe("formatTerraformModule", () => {
  it("recognizes RDS module sources", () => {
    expect(formatTerraformModule("terraform-aws-modules/rds/aws", "db")).toBe(
      "AWS RDS Module",
    );
  });

  it("recognizes security-group module sources", () => {
    expect(
      formatTerraformModule("terraform-aws-modules/security-group/aws", "sg"),
    ).toBe("AWS Security Group");
  });

  it("recognizes VPC module sources", () => {
    expect(
      formatTerraformModule("terraform-aws-modules/vpc/aws", "network"),
    ).toBe("AWS VPC Module");
  });

  it("falls back to Module: <name> for unknown sources", () => {
    expect(formatTerraformModule("./modules/custom", "mymod")).toBe(
      "Module: mymod",
    );
    expect(formatTerraformModule("hashicorp/consul/aws", "consul")).toBe(
      "Module: consul",
    );
  });
});

describe("parseTerraformResources", () => {
  it("parses a single resource block", () => {
    const content = `resource "aws_db_instance" "mysql" {
  engine = "mysql"
}`;
    const resources = parseTerraformResources(content);
    expect(resources).toHaveLength(1);
    expect(resources[0]).toEqual({
      name: "mysql",
      type: "aws_db_instance",
      apiVersion: "",
      provider: "aws",
      displayType: "AWS Db Instance",
    });
  });

  it("parses multiple resource blocks", () => {
    const content = `
resource "aws_security_group" "web" {
  name = "web-sg"
}

resource "azurerm_resource_group" "rg" {
  name     = "example"
  location = "eastus"
}
`;
    const resources = parseTerraformResources(content);
    expect(resources).toHaveLength(2);
    expect(resources[0].provider).toBe("aws");
    expect(resources[0].name).toBe("web");
    expect(resources[1].provider).toBe("azure");
    expect(resources[1].name).toBe("rg");
  });

  it("parses module blocks with source", () => {
    const content = `module "db" {
  source  = "terraform-aws-modules/rds/aws"
  version = "5.0.0"
}`;
    const resources = parseTerraformResources(content);
    expect(resources).toHaveLength(1);
    expect(resources[0]).toEqual({
      name: "db",
      type: "terraform-aws-modules/rds/aws",
      apiVersion: "",
      provider: "aws",
      displayType: "AWS RDS Module",
    });
  });

  it("assigns 'cloud' provider for non-aws/azure resource types", () => {
    const content = `resource "google_compute_instance" "vm" {
  name = "test"
}`;
    const resources = parseTerraformResources(content);
    expect(resources).toHaveLength(1);
    expect(resources[0].provider).toBe("cloud");
  });

  it("assigns 'cloud' provider for modules without aws in source", () => {
    const content = `module "consul" {
  source = "hashicorp/consul/gcp"
}`;
    const resources = parseTerraformResources(content);
    expect(resources).toHaveLength(1);
    expect(resources[0].provider).toBe("cloud");
  });

  it("uses module name as source when no source attribute found", () => {
    const content = `module "local_mod" {
  variable = "value"
}`;
    const resources = parseTerraformResources(content);
    expect(resources).toHaveLength(1);
    expect(resources[0].type).toBe("local_mod");
    expect(resources[0].displayType).toBe("Module: local_mod");
  });

  it("returns empty array for empty content", () => {
    expect(parseTerraformResources("")).toEqual([]);
  });

  it("returns empty array for content with no resource/module blocks", () => {
    const content = `
variable "region" {
  default = "us-east-1"
}

provider "aws" {
  region = var.region
}
`;
    expect(parseTerraformResources(content)).toEqual([]);
  });

  it("handles mixed resources and modules", () => {
    const content = `
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}

module "sg" {
  source = "terraform-aws-modules/security-group/aws"
}

resource "azurerm_virtual_network" "vnet" {
  name = "my-vnet"
}
`;
    const resources = parseTerraformResources(content);
    expect(resources).toHaveLength(3);
    expect(resources[0].type).toBe("aws_vpc");
    expect(resources[1].displayType).toBe("AWS Security Group");
    expect(resources[2].provider).toBe("azure");
  });
});
