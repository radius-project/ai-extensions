// Radius.AI/search on Amazon OpenSearch Service (single-node VPC domain).
//
// OpenSearch has no API keys. The domain uses fine-grained access control with
// an internal master user over HTTPS, and `apiKey` carries that user's HTTP
// Basic credential: base64('<user>:<password>'). Send it as
// `Authorization: Basic <apiKey>`.
// The master password comes from `adminPassword`, which defaults to newGuid()
// and so rotates on every redeploy. The recipe prefixes it so it always meets
// the OpenSearch rule of upper case, lower case, digit, and special character.
// VPC domains need the AWSServiceRoleForAmazonOpenSearchService service-linked
// role to exist in the account.

extension aws

@description('Radius-provided object containing information about the resource calling the Recipe.')
param context object

@description('Name of the EKS cluster the application runs on.')
param eksClusterName string

@description('Comma-separated subnet IDs. The domain uses the first one.')
param subnetIds string

@description('AWS region of the domain.')
param region string

@description('AWS account ID that owns the domain.')
param accountId string

@description('OpenSearch engine version.')
param engineVersion string = 'OpenSearch_2.19'

@description('Data node instance type.')
param instanceType string = 't3.small.search'

@description('EBS volume size in GiB.')
param volumeSize int = 10

@description('Master user name.')
param adminUsername string = 'searchadmin'

@secure()
@description('Master user password. Defaults to a new value on every deployment.')
param adminPassword string = newGuid()

var masterPassword = 'Rs1-${adminPassword}'
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

var domainName = 'search-${suffix}'
resource domain 'AWS.OpenSearchService/Domain@default' = {
  alias: domainName
  #disable-next-line use-stable-resource-identifiers
  properties: {
    DomainName: domainName
    EngineVersion: engineVersion
    ClusterConfig: {
      InstanceType: instanceType
      InstanceCount: 1
      DedicatedMasterEnabled: false
      ZoneAwarenessEnabled: false
    }
    EBSOptions: {
      EBSEnabled: true
      VolumeType: 'gp3'
      VolumeSize: volumeSize
    }
    VPCOptions: {
      SubnetIds: [
        first(split(subnetIds, ','))
      ]
      SecurityGroupIds: [
        eksCluster.properties.ClusterSecurityGroupId
      ]
    }
    EncryptionAtRestOptions: {
      Enabled: true
    }
    NodeToNodeEncryptionOptions: {
      Enabled: true
    }
    DomainEndpointOptions: {
      EnforceHTTPS: true
      TLSSecurityPolicy: 'Policy-Min-TLS-1-2-2019-07'
    }
    AdvancedSecurityOptions: {
      Enabled: true
      InternalUserDatabaseEnabled: true
      AnonymousAuthEnabled: false
      MasterUserOptions: {
        MasterUserName: adminUsername
        MasterUserPassword: masterPassword
      }
    }
    // Fine-grained access control does the authentication, so the resource
    // policy is open. The AWS type definitions model it as a closed object.
    AccessPolicies: any({
      Version: '2012-10-17'
      Statement: [
        {
          Effect: 'Allow'
          Principal: {
            AWS: '*'
          }
          Action: 'es:ESHttp*'
          Resource: 'arn:aws:es:${region}:${accountId}:domain/${domainName}/*'
        }
      ]
    })
    Tags: tags
  }
}

output result object = {
  values: {
    endpoint: 'https://${domain.properties.DomainEndpoint}'
  }
  secrets: {
    #disable-next-line outputs-should-not-contain-secrets
    apiKey: base64('${adminUsername}:${masterPassword}')
  }
}
