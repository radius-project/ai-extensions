// Terraform recipe parsing + display formatting — pure.

// Parse a Terraform recipe file to extract concrete resource declarations
export function parseTerraformResources(content: string): any[] {
  const resources: any[] = [];
  // Match terraform resource/module blocks: resource "type" "name" { or module "name" {
  const resourceRegex = /(?:resource\s+"([^"]+)"\s+"([^"]+)"|module\s+"([^"]+)")/g;
  let match;
  while ((match = resourceRegex.exec(content)) !== null) {
    if (match[1]) {
      // resource "aws_db_instance" "mysql"
      const tfType = match[1];
      const name = match[2];
      resources.push({
        name: name,
        type: tfType,
        apiVersion: "",
        provider: tfType.startsWith("aws_") ? "aws" : tfType.startsWith("azurerm_") ? "azure" : "cloud",
        displayType: formatTerraformType(tfType),
      });
    } else if (match[3]) {
      // module "db" - look for source to determine type
      const modName = match[3];
      const modStart = match.index;
      const modBlock = content.substring(modStart, modStart + 500);
      const sourceMatch = modBlock.match(/source\s*=\s*"([^"]+)"/);
      const source = sourceMatch ? sourceMatch[1] : modName;
      resources.push({
        name: modName,
        type: source,
        apiVersion: "",
        provider: source.includes("aws") ? "aws" : "cloud",
        displayType: formatTerraformModule(source, modName),
      });
    }
  }
  return resources;
}

// Format Terraform resource type for display
export function formatTerraformType(tfType: string): string {
  // aws_db_instance -> AWS RDS Instance
  // aws_security_group -> AWS Security Group
  if (tfType.startsWith("aws_")) {
    const parts = tfType.replace("aws_", "").split("_");
    return "AWS " + parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
  }
  if (tfType.startsWith("azurerm_")) {
    const parts = tfType.replace("azurerm_", "").split("_");
    return "Azure " + parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
  }
  return tfType;
}

// Format Terraform module for display
export function formatTerraformModule(source: string, name: string): string {
  // terraform-aws-modules/rds/aws -> AWS RDS Module
  if (source.includes("/rds/")) return "AWS RDS Module";
  if (source.includes("/security-group/")) return "AWS Security Group";
  if (source.includes("/vpc/")) return "AWS VPC Module";
  return `Module: ${name}`;
}
