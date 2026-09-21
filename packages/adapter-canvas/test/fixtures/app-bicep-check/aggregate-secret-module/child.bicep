extension radius

param application string
param environment string
param secretName string
param outputName string

resource web 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'web'
  properties: {
    environment: environment
    application: application
    codeReference: 'src/web.ts#L1'
    containers: {
      web: {
        image: 'example.invalid/web:latest'
        env: {
          REDIS_ADDR: {
            valueFrom: {
              secretKeyRef: {
                secretName: secretName
                key: outputName
              }
            }
          }
        }
      }
    }
  }
}
