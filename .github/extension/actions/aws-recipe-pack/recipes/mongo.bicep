// Radius.Data/mongoDatabases on Amazon DocumentDB elastic clusters.
//
// Elastic clusters are used because instance-based DocumentDB
// (AWS::DocDB::DBCluster and AWS::DocDB::DBInstance) is not provisionable
// through Cloud Control, which Radius uses for AWS resources.
// Elastic clusters always require TLS and have no parameter group to turn it
// off, so the connection string sets tls=true. They behave like mongos, so the
// connection string must not set replicaSet.
// The admin password comes from `adminPassword`, which defaults to newGuid()
// and so rotates on every redeploy.

extension aws

@description('Radius-provided object containing information about the resource calling the Recipe.')
param context object

@description('Name of the EKS cluster the application runs on.')
param eksClusterName string

@description('Comma-separated subnet IDs, spanning at least two availability zones.')
param subnetIds string

@description('vCPUs per shard instance. 2 is the smallest size.')
param shardCapacity int = 2

@description('Admin user name.')
param adminUsername string = 'mongoadmin'

@secure()
@description('Admin user password. Defaults to a new value on every deployment.')
param adminPassword string = newGuid()

var properties = context.resource.properties
var database = properties.?database ?? 'mongo_db'
var port = 27017
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

var clusterName = 'mongo-${suffix}'
resource cluster 'AWS.DocDBElastic/Cluster@default' = {
  alias: clusterName
  #disable-next-line use-stable-resource-identifiers
  properties: {
    ClusterName: clusterName
    AuthType: 'PLAIN_TEXT'
    AdminUserName: adminUsername
    AdminUserPassword: adminPassword
    ShardCapacity: shardCapacity
    ShardCount: 1
    ShardInstanceCount: 1
    SubnetIds: split(subnetIds, ',')
    VpcSecurityGroupIds: [
      eksCluster.properties.ClusterSecurityGroupId
    ]
    BackupRetentionPeriod: 1
    Tags: tags
  }
}

var host = cluster.properties.ClusterEndpoint

output result object = {
  values: {
    endpoint: '${host}:${port}'
  }
  secrets: {
    #disable-next-line outputs-should-not-contain-secrets
    connectionString: 'mongodb://${adminUsername}:${adminPassword}@${host}:${port}/${database}?tls=true&authSource=admin&readPreference=secondaryPreferred&retryWrites=false'
  }
}
