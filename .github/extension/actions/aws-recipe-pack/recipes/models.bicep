// Radius.AI/models on Amazon Bedrock.
//
// - On-demand foundation models need nothing provisioned, so this recipe
//   creates no AWS resources. It returns the regional Bedrock runtime endpoint
//   and maps the requested model to a Bedrock model ID.
// - Names Bedrock serves only through cross-region inference map to the
//   global inference profile. Unmapped names pass through unchanged, so a
//   developer can also set a Bedrock model ID directly.
// - The type's apiKey secret is not returned. A Bedrock API key needs an IAM
//   identity, which a recipe cannot create. The app must get AWS credentials or
//   a Bedrock API key another way.

@description('Radius-provided object containing information about the resource calling the Recipe.')
param context object

@description('AWS region the application runs in.')
param region string

var properties = context.resource.properties
var model = properties.?model ?? 'gpt-5-mini'
var bedrockModelIds = {
  'gpt-oss-20b': 'openai.gpt-oss-20b-1:0'
  'gpt-oss-120b': 'openai.gpt-oss-120b-1:0'
  'gpt-5.4': 'global.openai.gpt-5.4'
  'gpt-5.5': 'global.openai.gpt-5.5'
  'gpt-5.6-sol': 'global.openai.gpt-5.6-sol'
  'gpt-5.6-terra': 'global.openai.gpt-5.6-terra'
  'gpt-5.6-luna': 'global.openai.gpt-5.6-luna'
  'gpt-6-sol': 'global.openai.gpt-6-sol'
  'gpt-6-luna': 'global.openai.gpt-6-luna'
  'gpt-6-astra': 'global.openai.gpt-6-astra'
  'gpt-6.1-sol': 'global.openai.gpt-6.1-sol'
}

output result object = {
  values: {
    model: bedrockModelIds[?model] ?? model
    endpoint: 'https://bedrock-runtime.${region}.amazonaws.com'
  }
}
