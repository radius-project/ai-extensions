// Radius.Data/redisCaches on Amazon ElastiCache Serverless (Valkey engine).
//
// Serverless is used instead of a node-based replication group because the
// replication group's CacheSubnetGroupName is create-only and write-only, so
// Radius would send it in every update patch and Cloud Control rejects that on
// redeploy. Valkey is Redis OSS compatible and is the cheapest serverless
// engine. Serverless endpoints always require TLS, so the URL uses `rediss://`.
// The access key is the password of a user named `default`, so a client can
// authenticate with the password alone. ElastiCache does not return passwords,
// so the recipe returns its parameter. The default rotates on every redeploy.
// Size maps to usage limits, since serverless has no node types. The user's
// identifier is UserId, which is stable, so the linter warning about newGuid()
// in its properties is suppressed.

extension aws

@description('Radius-provided object containing information about the resource calling the Recipe.')
param context object

@description('Name of the EKS cluster the application runs on.')
param eksClusterName string

@description('Comma-separated subnet IDs, spanning at least two availability zones.')
param subnetIds string

@description('Password of the cache user. 16 to 128 printable characters, no spaces, quotes, slashes, or @.')
@secure()
param adminPassword string = newGuid()

var properties = context.resource.properties
var size = properties.?size ?? 'S'
var limits = {
  S: {
    dataStorageGB: 1
    ecpuPerSecond: 5000
  }
  M: {
    dataStorageGB: 5
    ecpuPerSecond: 15000
  }
  L: {
    dataStorageGB: 10
    ecpuPerSecond: 30000
  }
}
var engine = 'valkey'
var port = 6379
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

var userId = 'redis-${suffix}'
resource user 'AWS.ElastiCache/User@default' = {
  alias: userId
  #disable-next-line use-stable-resource-identifiers
  properties: {
    UserId: userId
    UserName: 'default'
    Engine: engine
    AccessString: 'on ~* &* +@all'
    AuthenticationMode: {
      Type: 'password'
      Passwords: [
        adminPassword
      ]
    }
    Tags: tags
  }
}

var userGroupId = 'redis-${suffix}'
resource userGroup 'AWS.ElastiCache/UserGroup@default' = {
  alias: userGroupId
  properties: {
    UserGroupId: userGroupId
    Engine: engine
    UserIds: [
      user.properties.UserId
    ]
    Tags: tags
  }
}

var cacheName = 'redis-${suffix}'
resource cache 'AWS.ElastiCache/ServerlessCache@default' = {
  alias: cacheName
  properties: {
    ServerlessCacheName: cacheName
    Description: 'Radius Redis ${context.resource.name}'
    Engine: engine
    MajorEngineVersion: '8'
    CacheUsageLimits: {
      DataStorage: {
        Maximum: limits[size].dataStorageGB
        Unit: 'GB'
      }
      ECPUPerSecond: {
        Maximum: limits[size].ecpuPerSecond
      }
    }
    SubnetIds: split(subnetIds, ',')
    SecurityGroupIds: [
      eksCluster.properties.ClusterSecurityGroupId
    ]
    UserGroupId: userGroup.properties.UserGroupId
    SnapshotRetentionLimit: 0
    Tags: tags
  }
}

var host = cache.properties.Endpoint.Address

output result object = {
  values: {
    host: host
    port: port
  }
  secrets: {
    #disable-next-line outputs-should-not-contain-secrets
    url: 'rediss://:${adminPassword}@${host}:${port}'
    #disable-next-line outputs-should-not-contain-secrets
    accessKey: adminPassword
  }
}
