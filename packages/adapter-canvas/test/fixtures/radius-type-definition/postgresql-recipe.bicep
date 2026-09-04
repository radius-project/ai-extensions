      'Radius.Data/postgreSqlDatabases': {
        kind: 'bicep'
        source: 'mcr.microsoft.com/bicep/avm/res/db-for-postgre-sql/flexible-server:0.15.2'
        parameters: {
          name: 'pgsql-{{context.azure.resourceNameHash}}'
          administratorLogin: '{{context.resource.properties.username}}'
          administratorLoginPassword: '{{context.resource.properties.password}}'
          authConfig: {
            activeDirectoryAuth: 'Enabled'
            passwordAuth: 'Enabled'
          }
          skuName: '{{context.resource.properties.size == "S" ? "Standard_B1ms" : "Standard_D2ds_v5"}}'
          tier: '{{context.resource.properties.size == "S" ? "Burstable" : "GeneralPurpose"}}'
          databases: [
            {
              name: '{{context.resource.properties.database}}'
            }
          ]
          version: '16'
          availabilityZone: -1
          highAvailability: 'Disabled'
          geoRedundantBackup: 'Disabled'
          storageSizeGB: 32
          publicNetworkAccess: 'Enabled'
          firewallRules: [
            {
              name: 'allow-all'
              startIpAddress: '0.0.0.0'
              endIpAddress: '255.255.255.255'
            }
          ]
          enableAdvancedThreatProtection: false
          enableTelemetry: false
          lock: {
            kind: 'None'
          }
          configurations: postgreSqlServerConfigurations
        }
        outputs: {
          host: 'fqdn'
        }
      }
