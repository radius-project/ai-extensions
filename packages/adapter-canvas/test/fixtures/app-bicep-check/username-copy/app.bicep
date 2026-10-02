extension radius

param environment string

var rabbitmqUsername = 'myadmin'

resource app 'Radius.Core/applications@2025-08-01-preview' = {
  name: 'test-app'
  properties: {
    environment: environment
  }
}

resource rabbitmq 'Radius.Messaging/rabbitMQ@2025-08-01-preview' = {
  name: 'rabbitmq'
  properties: {
    environment: environment
    application: app.id
    codeReference: 'src/queue.ts#L1'
    queue: 'orders'
    username: rabbitmqUsername
  }
}

resource web 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'web'
  properties: {
    environment: environment
    application: app.id
    codeReference: 'src/web.ts#L1'
    containers: {
      web: {
        image: 'example.invalid/web:latest'
        env: {
          ORDER_QUEUE_LOGIN: {
            value: rabbitmqUsername
          }
          ORDER_QUEUE_USER: {
            value: rabbitmq.properties.username
          }
          ORDER_QUEUE_USERNAME: {
            value: 'myadmin'
          }
        }
      }
    }
  }
}
