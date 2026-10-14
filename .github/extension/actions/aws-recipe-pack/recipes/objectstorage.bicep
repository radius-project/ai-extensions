// Radius.Storage/objectStorage on Amazon S3.
//
// - S3 bucket names are global across all AWS accounts, so the name hashes the
//   account ID with the resource ID. The developer's containerName cannot be
//   the bucket name; the recipe returns the real bucket name as containerName.
// - The type's secrets (accountKey, connectionString) are Azure account keys.
//   S3 needs IAM credentials, which a recipe cannot create, so no secrets are
//   returned. The app must get AWS credentials another way.
// - Cloud Control cannot delete a bucket that still holds objects. Empty the
//   bucket before deleting the resource.

extension aws

@description('Radius-provided object containing information about the resource calling the Recipe.')
param context object

@description('AWS account ID. Keeps the globally unique bucket name distinct across accounts.')
param accountId string

var suffix = uniqueString(accountId, context.resource.id)
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

var bucketName = 'store-${suffix}'
resource bucket 'AWS.S3/Bucket@default' = {
  alias: bucketName
  properties: {
    BucketName: bucketName
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        {
          ServerSideEncryptionByDefault: {
            SSEAlgorithm: 'AES256'
          }
          BucketKeyEnabled: true
        }
      ]
    }
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true
      BlockPublicPolicy: true
      IgnorePublicAcls: true
      RestrictPublicBuckets: true
    }
    OwnershipControls: {
      Rules: [
        {
          ObjectOwnership: 'BucketOwnerEnforced'
        }
      ]
    }
    Tags: tags
  }
}

output result object = {
  values: {
    containerName: bucketName
    // RegionalDomainName is <bucket>.s3.<region>.amazonaws.com; drop the bucket
    // label to get the regional service endpoint.
    endpoint: 'https://${substring(bucket.properties.RegionalDomainName, length(bucketName) + 1)}'
  }
}
