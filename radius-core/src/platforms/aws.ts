import type { ComputePlatform, OidcResult, PortalContext } from "./types.js";

export const aws: ComputePlatform = {
  id: "aws",
  displayName: "AWS",
  recipePlatform: "aws",
  clusterServiceName: "EKS",
  supports: { oidc: true, portalUrl: true },

  generateOidc(data: any): OidcResult {
    return {
      message: "AWS authentication validated",
      output: `# AWS OIDC Authentication Verified
Account ID: ${data.accountId || ""}
Region: ${data.region || ""}

# GitHub Actions will use OIDC to assume a role in this account.
# The following variables have been configured (these identifiers are not secret):

gh variable set AWS_ACCOUNT_ID --body "${data.accountId || ""}"
gh variable set AWS_REGION --body "${data.region || ""}"
`,
    };
  },

  environmentSecrets(data: any) {
    return [
      { kind: "variable" as const, name: "AWS_ACCOUNT_ID", value: data.accountId },
      { kind: "variable" as const, name: "AWS_REGION", value: data.region },
    ];
  },

  portalUrl(resourceType: string, ctx: PortalContext): string {
    const region = ctx.region;
        const awsBase = `https://${region}.console.aws.amazon.com`;

        if (resourceType.includes('aws_db_instance') || resourceType.includes('RDS')) {
            return `${awsBase}/rds/home?region=${region}#databases:`;
        }
        if (resourceType.includes('aws_secretsmanager') || resourceType.includes('Secrets Manager')) {
            return `${awsBase}/secretsmanager/home?region=${region}#!/listSecrets`;
        }
        if (resourceType.includes('aws_ecr') || resourceType.includes('ECR')) {
            return `${awsBase}/ecr/repositories?region=${region}`;
        }
        if (resourceType.includes('aws_lb') || resourceType.includes('Load Balancer')) {
            return `${awsBase}/ec2/home?region=${region}#LoadBalancers:`;
        }
        if (resourceType.includes('aws_ebs') || resourceType.includes('EBS')) {
            return `${awsBase}/ec2/home?region=${region}#Volumes:`;
        }
        if (resourceType.includes('aws_security_group') || resourceType.includes('Security Group')) {
            return `${awsBase}/ec2/home?region=${region}#SecurityGroups:`;
        }
        if (resourceType.includes('aws_db_subnet') || resourceType.includes('Subnet Group')) {
            return `${awsBase}/rds/home?region=${region}#db-subnet-groups-list:`;
        }
        if (resourceType.includes('aws_elasticache') || resourceType.includes('MemoryDB')) {
            return `${awsBase}/memorydb/home?region=${region}#/clusters`;
        }
        // K8s resources link to EKS cluster
        if (resourceType.includes('apps/Deployment') || resourceType.includes('core/Service') || resourceType.includes('Ingress') || resourceType.includes('PersistentVolume')) {
            return `${awsBase}/eks/home?region=${region}#/clusters`;
        }
    return "";
  },

  verifyWorkflowSteps: `
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: \${{ secrets.AWS_IAM_ROLE_ARN }}
          aws-region: \${{ vars.AWS_REGION }}

      - name: Verify AWS Credentials
        run: |
          aws sts get-caller-identity
          echo "✅ AWS OIDC login successful"

      - name: Verify EKS Access
        run: |
          aws eks update-kubeconfig --name "\${{ vars.RADIUS_K8S_CLUSTER }}" --region "\${{ vars.AWS_REGION }}"
          kubectl cluster-info
          echo "✅ EKS cluster accessible"
`,
  deployClusterAuthSteps: `
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: \${{ secrets.AWS_IAM_ROLE_ARN }}
          aws-region: \${{ vars.AWS_REGION }}

      - name: Capture target EKS kubeconfig (static service-account token)
        run: |
          aws eks update-kubeconfig --name "\${{ vars.RADIUS_K8S_CLUSTER }}" --region "\${{ vars.AWS_REGION }}" --kubeconfig /tmp/eks-config
          export KUBECONFIG=/tmp/eks-config
          kubectl create serviceaccount radius-deployer -n kube-system || true
          kubectl create clusterrolebinding radius-deployer --clusterrole=cluster-admin --serviceaccount=kube-system:radius-deployer || true
          TOKEN=\$(kubectl create token radius-deployer -n kube-system --duration=8h)
          SERVER=\$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
          CA=\$(kubectl config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
          cat > /tmp/target-kubeconfig <<EOF
          apiVersion: v1
          kind: Config
          clusters:
          - name: target
            cluster:
              server: \${SERVER}
              certificate-authority-data: \${CA}
          contexts:
          - name: target
            context:
              cluster: target
              user: radius-deployer
          current-context: target
          users:
          - name: radius-deployer
            user:
              token: \${TOKEN}
          EOF
          echo "TARGET_KUBECONFIG=/tmp/target-kubeconfig" >> "\$GITHUB_ENV"
`,
  radCredentialRegister: `rad credential register aws irsa --iam-role "\${{ secrets.AWS_IAM_ROLE_ARN }}"
          rad env update "\${{ env.RADIUS_ENV }}" --aws-region "\${{ vars.AWS_REGION }}" --aws-account-id "\${{ vars.AWS_ACCOUNT_ID }}"`,
  recipeAuthEnv: ``,
  dbRecipeRegister: `          # Database: managed AWS RDS MySQL (aws/terraform recipe)
          rad recipe register default \\
            --resource-type "Radius.Data/mySqlDatabases" \\
            --template-kind terraform \\
            --template-path "git::https://github.com/radius-project/resource-types-contrib.git//Data/mySqlDatabases/recipes/aws/terraform?ref=\${{ env.RESOURCE_TYPES_CONTRIB_REF }}" \\
            --environment "\${{ env.RADIUS_ENV }}"`,
};
