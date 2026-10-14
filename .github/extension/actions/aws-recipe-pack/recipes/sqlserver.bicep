// Radius.Data/sqlServerDatabases on Amazon RDS for SQL Server Express (sqlserver-ex, license-included).
// RDS for SQL Server does not support DBName, so no database is created at instance creation.
// The app must create the database named by the resource's database property on first connect.
// SQL Server Express does not support Multi-AZ.

extension aws

@description('Radius-provided object containing information about the resource calling the Recipe.')
param context object

@description('Name of the EKS cluster the application runs on.')
param eksClusterName string

@description('Comma-separated subnet IDs, spanning at least two availability zones.')
param subnetIds string

@description('RDS instance class.')
param instanceClass string = 'db.t3.micro'

@description('Allocated storage in GiB. SQL Server requires at least 20.')
param allocatedStorage string = '20'

var properties = context.resource.properties
var port = 1433
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

var subnetGroupName = 'sqlserver-${suffix}'
resource subnetGroup 'AWS.RDS/DBSubnetGroup@default' = {
  alias: subnetGroupName
  properties: {
    DBSubnetGroupName: subnetGroupName
    DBSubnetGroupDescription: 'Radius SQL Server ${context.resource.name}'
    SubnetIds: split(subnetIds, ',')
    Tags: tags
  }
}

var instanceName = 'sqlserver-${suffix}'
resource instance 'AWS.RDS/DBInstance@default' = {
  alias: instanceName
  properties: {
    DBInstanceIdentifier: instanceName
    Engine: 'sqlserver-ex'
    LicenseModel: 'license-included'
    DBInstanceClass: instanceClass
    AllocatedStorage: allocatedStorage
    StorageType: 'gp3'
    StorageEncrypted: true
    MasterUsername: properties.username
    MasterUserPassword: properties.password
    Port: string(port)
    DBSubnetGroupName: subnetGroup.properties.DBSubnetGroupName
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
