extension radius

param environment string

@secure()
param rabbitmqPassword string

@secure()
param registryPassword string

@secure()
param registryUsername string

resource aksStoreDemoApp 'Radius.Core/applications@2025-08-01-preview' = {
  name: 'aks-store-demo'
  properties: {
    environment: environment
  }
}

resource mongoDb 'Radius.Data/mongoDatabases@2025-08-01-preview' = {
  name: 'mongo'
  properties: {
    environment: environment
    application: aksStoreDemoApp.id
    codeReference: 'src/makeline-service/mongodb.go#L149'
    database: 'orderdb'
  }
}

resource rabbitmq 'Radius.Messaging/rabbitMQ@2025-08-01-preview' = {
  name: 'rabbitmq'
  properties: {
    environment: environment
    application: aksStoreDemoApp.id
    codeReference: 'src/order-service/plugins/messagequeue.js#L26'
    password: rabbitmqSecret.id
    queue: 'orders'
    username: 'myadmin'
  }
}

resource rabbitmqSecret 'Radius.Security/secrets@2025-08-01-preview' = {
  name: 'rabbitmq-secret'
  properties: {
    environment: environment
    application: aksStoreDemoApp.id
    codeReference: 'src/order-service/plugins/messagequeue.js#L29'
    data: {
      password: {
        value: rabbitmqPassword
      }
    }
  }
}

// Do not change this Secret's name value from 'radius-ghcr-registry-creds'.
// The containerImages recipe looks up registry credentials by that fixed name.
resource registryCreds 'Radius.Security/secrets@2025-08-01-preview' = {
  name: 'radius-ghcr-registry-creds'
  properties: {
    environment: environment
    application: aksStoreDemoApp.id
    codeReference: '.radius/app.bicep'
    data: {
      password: {
        value: registryPassword
      }
      username: {
        value: registryUsername
      }
    }
  }
}

resource makelineServiceImage 'Radius.Compute/containerImages@2025-08-01-preview' = {
  name: 'makeline-service-image'
  properties: {
    environment: environment
    application: aksStoreDemoApp.id
    codeReference: 'src/makeline-service/Dockerfile'
    build: {
      source: 'git::https://github.com/kachawla/aks-store-demo.git//src/makeline-service?ref=15755ec3d15344216a9b124a058a9dc677ee6eac'
      platforms: [
        'linux/amd64'
      ]
    }
  }
  dependsOn: [
    registryCreds
  ]
}

resource orderServiceImage 'Radius.Compute/containerImages@2025-08-01-preview' = {
  name: 'order-service-image'
  properties: {
    environment: environment
    application: aksStoreDemoApp.id
    codeReference: 'src/order-service/Dockerfile'
    build: {
      source: 'git::https://github.com/kachawla/aks-store-demo.git//src/order-service?ref=15755ec3d15344216a9b124a058a9dc677ee6eac'
      platforms: [
        'linux/amd64'
      ]
    }
  }
  dependsOn: [
    registryCreds
  ]
}

resource productServiceImage 'Radius.Compute/containerImages@2025-08-01-preview' = {
  name: 'product-service-image'
  properties: {
    environment: environment
    application: aksStoreDemoApp.id
    codeReference: 'src/product-service/Dockerfile'
    build: {
      source: 'git::https://github.com/kachawla/aks-store-demo.git//src/product-service?ref=15755ec3d15344216a9b124a058a9dc677ee6eac'
      platforms: [
        'linux/amd64'
      ]
    }
  }
  dependsOn: [
    registryCreds
  ]
}

resource storeAdminImage 'Radius.Compute/containerImages@2025-08-01-preview' = {
  name: 'store-admin-image'
  properties: {
    environment: environment
    application: aksStoreDemoApp.id
    codeReference: 'src/store-admin/Dockerfile'
    build: {
      source: 'git::https://github.com/kachawla/aks-store-demo.git//src/store-admin?ref=15755ec3d15344216a9b124a058a9dc677ee6eac'
      platforms: [
        'linux/amd64'
      ]
    }
  }
  dependsOn: [
    registryCreds
  ]
}

resource storeFrontImage 'Radius.Compute/containerImages@2025-08-01-preview' = {
  name: 'store-front-image'
  properties: {
    environment: environment
    application: aksStoreDemoApp.id
    codeReference: 'src/store-front/Dockerfile'
    build: {
      source: 'git::https://github.com/kachawla/aks-store-demo.git//src/store-front?ref=15755ec3d15344216a9b124a058a9dc677ee6eac'
      platforms: [
        'linux/amd64'
      ]
    }
  }
  dependsOn: [
    registryCreds
  ]
}

resource virtualCustomerImage 'Radius.Compute/containerImages@2025-08-01-preview' = {
  name: 'virtual-customer-image'
  properties: {
    environment: environment
    application: aksStoreDemoApp.id
    codeReference: 'src/virtual-customer/Dockerfile'
    build: {
      source: 'git::https://github.com/kachawla/aks-store-demo.git//src/virtual-customer?ref=15755ec3d15344216a9b124a058a9dc677ee6eac'
      platforms: [
        'linux/amd64'
      ]
    }
  }
  dependsOn: [
    registryCreds
  ]
}

resource virtualWorkerImage 'Radius.Compute/containerImages@2025-08-01-preview' = {
  name: 'virtual-worker-image'
  properties: {
    environment: environment
    application: aksStoreDemoApp.id
    codeReference: 'src/virtual-worker/Dockerfile'
    build: {
      source: 'git::https://github.com/kachawla/aks-store-demo.git//src/virtual-worker?ref=15755ec3d15344216a9b124a058a9dc677ee6eac'
      platforms: [
        'linux/amd64'
      ]
    }
  }
  dependsOn: [
    registryCreds
  ]
}

resource makelineServiceContainer 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'makeline-service'
  properties: {
    environment: environment
    application: aksStoreDemoApp.id
    codeReference: 'src/makeline-service/main.go#L21'
    replicas: 1
    containers: {
      'makeline-service': {
        image: makelineServiceImage.properties.imageReference
        env: {
          ORDER_DB_API: {
            value: 'mongodb'
          }
          ORDER_DB_COLLECTION_NAME: {
            value: 'orders'
          }
          ORDER_DB_NAME: {
            value: 'orderdb'
          }
          ORDER_DB_URI: {
            valueFrom: {
              secretKeyRef: {
                secretName: mongoDb.properties.secrets.name
                key: 'connectionString'
              }
            }
          }
          ORDER_QUEUE_NAME: {
            value: 'orders'
          }
          ORDER_QUEUE_PASSWORD: {
            valueFrom: {
              secretKeyRef: {
                secretName: rabbitmqSecret.name
                key: 'password'
              }
            }
          }
          ORDER_QUEUE_URI: {
            value: 'amqp://${rabbitmq.properties.host}:${rabbitmq.properties.port}'
          }
          ORDER_QUEUE_USERNAME: {
            value: rabbitmq.properties.username
          }
        }
        ports: {
          web: {
            containerPort: 3001
          }
        }
        livenessProbe: {
          httpGet: {
            path: '/liveness'
            port: 3001
          }
          initialDelaySeconds: 3
          periodSeconds: 3
          failureThreshold: 5
        }
        readinessProbe: {
          httpGet: {
            path: '/health'
            port: 3001
          }
          initialDelaySeconds: 3
          periodSeconds: 5
          failureThreshold: 3
        }
      }
    }
  }
}

resource orderServiceContainer 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'order-service'
  properties: {
    environment: environment
    application: aksStoreDemoApp.id
    codeReference: 'src/order-service/app.js#L5'
    replicas: 1
    containers: {
      'order-service': {
        image: orderServiceImage.properties.imageReference
        env: {
          FASTIFY_ADDRESS: {
            value: '0.0.0.0'
          }
          ORDER_QUEUE_HOSTNAME: {
            value: rabbitmq.properties.host
          }
          ORDER_QUEUE_NAME: {
            value: 'orders'
          }
          ORDER_QUEUE_PASSWORD: {
            valueFrom: {
              secretKeyRef: {
                secretName: rabbitmqSecret.name
                key: 'password'
              }
            }
          }
          ORDER_QUEUE_PORT: {
            value: '${rabbitmq.properties.port}'
          }
          ORDER_QUEUE_USERNAME: {
            value: rabbitmq.properties.username
          }
        }
        ports: {
          web: {
            containerPort: 3000
          }
        }
        livenessProbe: {
          httpGet: {
            path: '/health'
            port: 3000
          }
          initialDelaySeconds: 3
          periodSeconds: 3
          failureThreshold: 5
        }
        readinessProbe: {
          httpGet: {
            path: '/health'
            port: 3000
          }
          initialDelaySeconds: 3
          periodSeconds: 5
          failureThreshold: 3
        }
      }
    }
  }
}

resource productServiceContainer 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'product-service'
  properties: {
    environment: environment
    application: aksStoreDemoApp.id
    codeReference: 'src/product-service/src/main.rs#L5'
    replicas: 1
    containers: {
      'product-service': {
        image: productServiceImage.properties.imageReference
        ports: {
          web: {
            containerPort: 3002
          }
        }
        livenessProbe: {
          httpGet: {
            path: '/health'
            port: 3002
          }
          initialDelaySeconds: 3
          periodSeconds: 3
          failureThreshold: 5
        }
        readinessProbe: {
          httpGet: {
            path: '/health'
            port: 3002
          }
          initialDelaySeconds: 3
          periodSeconds: 5
          failureThreshold: 3
        }
      }
    }
  }
}

resource storeAdminContainer 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'store-admin'
  properties: {
    environment: environment
    application: aksStoreDemoApp.id
    codeReference: 'src/store-admin/nginx.conf#L1'
    replicas: 1
    containers: {
      'store-admin': {
        image: storeAdminImage.properties.imageReference
        command: [
          '/bin/sh'
          '-c'
        ]
        args: [
          'sed -i "s|http://order-service:3000|http://$ORDER_SERVICE_HOST:3000|g; s|http://product-service:3002|http://$PRODUCT_SERVICE_HOST:3002|g; s|http://makeline-service:3001|http://$MAKELINE_SERVICE_HOST:3001|g" /etc/nginx/conf.d/default.conf && nginx -g "daemon off;"'
        ]
        env: {
          MAKELINE_SERVICE_HOST: {
            value: makelineServiceContainer.properties.hosts['makeline-service']
          }
          ORDER_SERVICE_HOST: {
            value: orderServiceContainer.properties.hosts['order-service']
          }
          PRODUCT_SERVICE_HOST: {
            value: productServiceContainer.properties.hosts['product-service']
          }
        }
        ports: {
          web: {
            containerPort: 8081
          }
        }
        livenessProbe: {
          httpGet: {
            path: '/health'
            port: 8081
          }
          initialDelaySeconds: 3
          periodSeconds: 3
          failureThreshold: 5
        }
        readinessProbe: {
          httpGet: {
            path: '/health'
            port: 8081
          }
          initialDelaySeconds: 3
          periodSeconds: 5
          failureThreshold: 3
        }
      }
    }
  }
}

resource storeFrontContainer 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'store-front'
  properties: {
    environment: environment
    application: aksStoreDemoApp.id
    codeReference: 'src/store-front/nginx.conf#L1'
    replicas: 1
    containers: {
      'store-front': {
        image: storeFrontImage.properties.imageReference
        command: [
          '/bin/sh'
          '-c'
        ]
        args: [
          'sed -i "s|http://order-service:3000|http://$ORDER_SERVICE_HOST:3000|g; s|http://product-service:3002|http://$PRODUCT_SERVICE_HOST:3002|g" /etc/nginx/conf.d/default.conf && nginx -g "daemon off;"'
        ]
        env: {
          ORDER_SERVICE_HOST: {
            value: orderServiceContainer.properties.hosts['order-service']
          }
          PRODUCT_SERVICE_HOST: {
            value: productServiceContainer.properties.hosts['product-service']
          }
        }
        ports: {
          web: {
            containerPort: 8080
          }
        }
        livenessProbe: {
          httpGet: {
            path: '/health'
            port: 8080
          }
          initialDelaySeconds: 3
          periodSeconds: 3
          failureThreshold: 5
        }
        readinessProbe: {
          httpGet: {
            path: '/health'
            port: 8080
          }
          initialDelaySeconds: 3
          periodSeconds: 5
          failureThreshold: 3
        }
      }
    }
  }
}

resource virtualCustomerContainer 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'virtual-customer'
  properties: {
    environment: environment
    application: aksStoreDemoApp.id
    codeReference: 'src/virtual-customer/src/main.rs#L7'
    replicas: 1
    containers: {
      'virtual-customer': {
        image: virtualCustomerImage.properties.imageReference
        env: {
          ORDERS_PER_HOUR: {
            value: '100'
          }
          ORDER_SERVICE_URL: {
            value: 'http://${orderServiceContainer.properties.hosts['order-service']}:3000/'
          }
        }
      }
    }
  }
}

resource virtualWorkerContainer 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'virtual-worker'
  properties: {
    environment: environment
    application: aksStoreDemoApp.id
    codeReference: 'src/virtual-worker/src/main.rs#L6'
    replicas: 1
    containers: {
      'virtual-worker': {
        image: virtualWorkerImage.properties.imageReference
        env: {
          MAKELINE_SERVICE_URL: {
            value: 'http://${makelineServiceContainer.properties.hosts['makeline-service']}:3001'
          }
          ORDERS_PER_HOUR: {
            value: '100'
          }
        }
      }
    }
  }
}

resource storeAdminRoute 'Radius.Compute/routes@2025-08-01-preview' = {
  name: 'store-admin-route'
  properties: {
    environment: environment
    application: aksStoreDemoApp.id
    codeReference: 'aks-store-all-in-one.yaml#L508'
    kind: 'HTTP'
    rules: [
      {
        matches: [
          {
            httpPath: '/'
          }
        ]
        destinationContainer: {
          resourceId: storeAdminContainer.id
          containerName: 'store-admin'
          containerPort: 8081
        }
      }
    ]
  }
}

resource storeFrontRoute 'Radius.Compute/routes@2025-08-01-preview' = {
  name: 'store-front-route'
  properties: {
    environment: environment
    application: aksStoreDemoApp.id
    codeReference: 'aks-store-all-in-one.yaml#L445'
    kind: 'HTTP'
    rules: [
      {
        matches: [
          {
            httpPath: '/'
          }
        ]
        destinationContainer: {
          resourceId: storeFrontContainer.id
          containerName: 'store-front'
          containerPort: 8080
        }
      }
    ]
  }
}
