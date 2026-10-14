// Radius.Data/mySqlDatabases on Amazon RDS for MySQL.
//
// Conventions shared by every AWS recipe in this folder:
// - The recipe pack passes `eksClusterName` and `subnetIds` (comma-separated)
//   from the environment's AWS_EKS_CLUSTER_NAME and RADIUS_SUBNET_IDS.
// - Network access uses the EKS cluster security group. Managed node groups
//   attach it to every node, and it allows all traffic between its members, so
//   pods reach the service without a new security group.
// - Names are `<prefix>-<uniqueString(resource id)>`, stable across redeploys.
// - Every resource carries the radapp.io tags the Kubernetes recipes use.
// - The result returns only the type's read-only properties.

extension aws

@description('Radius-provided object containing information about the resource calling the Recipe.')
param context object

@description('Name of the EKS cluster the application runs on.')
param eksClusterName string

@description('Comma-separated subnet IDs, spanning at least two availability zones.')
param subnetIds string

@description('RDS instance class.')
param instanceClass string = 'db.t3.micro'

@description('Allocated storage in GiB.')
param allocatedStorage string = '20'

var properties = context.resource.properties
var version = properties.?version ?? '8.4'
var database = properties.?database ?? 'mysql_db'
var requireTls = (properties.?tls ?? 'required') == 'required'
var port = 3306
var suffix = uniqueString(context.resource.id)
var tags = [
  {
    Key: 'radapp.io/environment'
    Value: context.environment.id
  }
  {
    Key: 'radapp.io/application'
    Value: context.application == null ? '' : context.application.id
  }
  {
    Key: 'radapp.io/resource'
    Value: context.resource.id
  }
]

resource eksCluster 'AWS.EKS/Cluster@default' existing = {
  alias: eksClusterName
  properties: {
    Name: eksClusterName
  }
}

var subnetGroupName = 'mysql-${suffix}'
resource subnetGroup 'AWS.RDS/DBSubnetGroup@default' = {
  alias: subnetGroupName
  properties: {
    DBSubnetGroupName: subnetGroupName
    DBSubnetGroupDescription: 'Radius MySQL ${context.resource.name}'
    SubnetIds: split(subnetIds, ',')
    Tags: tags
  }
}

var parameterGroupName = 'mysql-${suffix}'
resource parameterGroup 'AWS.RDS/DBParameterGroup@default' = {
  alias: parameterGroupName
  properties: {
    DBParameterGroupName: parameterGroupName
    Description: 'Radius MySQL ${context.resource.name}'
    Family: 'mysql${version}'
    // The AWS type definitions model free-form maps as closed objects.
    Parameters: any({
      require_secure_transport: requireTls ? '1' : '0'
    })
    Tags: tags
  }
}

var instanceName = 'mysql-${suffix}'
resource instance 'AWS.RDS/DBInstance@default' = {
  alias: instanceName
  properties: {
    DBInstanceIdentifier: instanceName
    Engine: 'mysql'
    EngineVersion: version
    DBInstanceClass: instanceClass
    AllocatedStorage: allocatedStorage
    StorageType: 'gp3'
    StorageEncrypted: true
    DBName: database
    MasterUsername: properties.username
    MasterUserPassword: properties.password
    Port: string(port)
    DBSubnetGroupName: subnetGroup.properties.DBSubnetGroupName
    DBParameterGroupName: parameterGroup.properties.DBParameterGroupName
    VPCSecurityGroups: [
      eksCluster.properties.ClusterSecurityGroupId
    ]
    PubliclyAccessible: false
    MultiAZ: false
    BackupRetentionPeriod: 1
    DeletionProtection: false
    DeleteAutomatedBackups: true
    Tags: tags
  }
}

output result object = {
  values: {
    host: instance.properties.Endpoint.Address
    port: port
  }
}
