# Custom resource types

A resource type describes a resource that a Recipe creates for the app when it deploys. Define a custom resource type only when all of these are true:

- The app needs the service for its main feature.
- A deployment must create the service for this app. A typical case is a managed cloud service that the app's SDK calls, such as a message broker, an email service, or a cloud AI service.
- No Radius type fits the service. Do not stretch a type to cover a different service. Do not define a new type only to get a different property or credential shape: report that gap instead.
- The deployment files do not run the service as a container from a published image. When they do, model it as a container.

These are not resources of the app, so do not define a type for them:

- The platform that the app runs on or manages, such as the Kubernetes API of a cluster dashboard, the container runtime, or a cloud account that the app administers. The app reaches it with its own service account or credentials.
- An existing service that the user configures by URL or account, such as a third-party API or a mail relay. Name its setting in your reply.

Do not use `Applications.Core/extenders`. Radius deprecates them.

## Write the schema

Write `custom-types.yaml` in the run directory. The check compiles it into the local Bicep extension `custom-types.tgz` and adds `customTypes` to `bicepconfig.json`, so run the check again after each change. At deployment, the deploy workflow registers the types from this file.

```yaml
namespace: Radius.Resources
types:
  messageQueues:
    description: A message queue that the app sends orders to.
    apiVersions:
      '2025-08-01-preview':
        schema:
          type: object
          properties:
            environment:
              type: string
              description: (Required) The Radius Environment ID.
            application:
              type: string
              description: (Optional) The Radius Application ID.
            codeReference:
              type: string
              description: (Optional) The source line that uses the resource.
            queue:
              type: string
              description: (Required) The name of the queue that the app uses.
            secrets:
              type: object
              description: (Read only) The secrets that the Recipe returns.
              properties:
                name:
                  type: string
                  readOnly: true
                  description: (Reserved) The name of the Radius secret that holds them.
                connectionString:
                  type: string
                  readOnly: true
                  description: The connection string of the queue.
          required: [environment, queue]
```

- Use the `Radius.Resources` namespace and a lowerCamelCase plural noun for the type name.
- Declare only the properties that the app sets or reads, in the app's terms. A Stage 2 Recipe maps them to a provider.
- Always declare `environment`, `application`, and `codeReference`. The extension accepts only declared properties, so a `codeReference` that the schema lacks does not compile. Do not list `codeReference` in `required`.
- An output that the Recipe sets has `readOnly: true`.
- A secret that the Recipe returns goes under `secrets`, beside the reserved `name`, as above. A container reads it with `secretKeyRef: { secretName: <resource>.properties.secrets.name, key: '<key>' }`.
- A secret that the app supplies, such as an API key, is an input with `x-radius-sensitive: true`. Stage 3 sets it from a `@secure()` parameter.

## Use the type in the model

Declare the extension beside `extension radius`, and give the resource the same properties as any backing service:

```bicep
extension radius
extension customTypes

resource ordersQueue 'Radius.Resources/messageQueues@2025-08-01-preview' = {
  name: 'orders'
  properties: {
    environment: environment
    application: shopApp.id
    codeReference: 'https://github.com/contoso/shop/blob/<commit>/api/queue.go#L12'
    queue: 'orders'
  }
}
```

Connect each workload that uses it with `dependsOn`. Stage 2 writes its Recipe, and Stage 3 wires its outputs and secrets.
