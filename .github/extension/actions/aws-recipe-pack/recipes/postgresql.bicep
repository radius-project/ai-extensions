// Radius.Data/postgreSqlDatabases on Amazon RDS for PostgreSQL 16.
// The schema has no version property, so the engine is pinned to PostgreSQL 16.
// size maps to an instance class: S is db.t4g.micro, M is db.t4g.medium, L is db.m7g.large.
// tls maps to rds.force_ssl in a dedicated parameter group.

extension aws

@description('Radius-provided object containing information about the resource calling the Recipe.')
param context object

@description('Name of the EKS cluster the application runs on.')
param eksClusterName string

@description('Comma-separated subnet IDs, spanning at least two availability zones.')
param subnetIds string

@description('Allocated storage in GiB.')
param allocatedStorage string = '20'

var properties = context.resource.properties
var version = '16'
var instanceClasses = {
  S: 'db.t4g.micro'
  M: 'db.t4g.medium'
  L: 'db.m7g.large'
}
var instanceClass = instanceClasses[properties.?size ?? 'S']
var database = properties.?database ?? 'postgres_db'
var requireTls = (properties.?tls ?? 'required') == 'required'
var port = 5432
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

var subnetGroupName = 'postgres-${suffix}'
resource subnetGroup 'AWS.RDS/DBSubnetGroup@default' = {
  alias: subnetGroupName
  properties: {
    DBSubnetGroupName: subnetGroupName
    DBSubnetGroupDescription: 'Radius PostgreSQL ${context.resource.name}'
    SubnetIds: split(subnetIds, ',')
    Tags: tags
  }
}

var parameterGroupName = 'postgres-${suffix}'
resource parameterGroup 'AWS.RDS/DBParameterGroup@default' = {
  alias: parameterGroupName
  properties: {
    DBParameterGroupName: parameterGroupName
    Description: 'Radius PostgreSQL ${context.resource.name}'
    Family: 'postgres${version}'
    // The AWS type definitions model free-form maps as closed objects.
    Parameters: any({
      'rds.force_ssl': requireTls ? '1' : '0'
    })
    Tags: tags
  }
}

var instanceName = 'postgres-${suffix}'
resource instance 'AWS.RDS/DBInstance@default' = {
  alias: instanceName
  properties: {
    DBInstanceIdentifier: instanceName
    Engine: 'postgres'
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
