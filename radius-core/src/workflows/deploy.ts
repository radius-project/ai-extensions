import type { ComputePlatform } from "../platforms/index.js";

/** Generate the application-deploy GitHub Actions workflow YAML. */
export function generateDeployWorkflow(
  env: string,
  platform: ComputePlatform,
  appFile: string,
): string {
  const clusterAuth = platform.deployClusterAuthSteps;
  const radCredRegister = platform.radCredentialRegister;
  const recipeAuthEnv = platform.recipeAuthEnv;
  const dbRecipeRegister = platform.dbRecipeRegister;
  return `name: Deploy Radius Application
on:
  workflow_dispatch:
    inputs:
      environment:
        description: 'Radius environment name'
        required: true
        default: '${env}'
  workflow_run:
    workflows: ["Radius - Verify Credentials"]
    types: [completed]

permissions:
  id-token: write
  contents: write

env:
  RESOURCE_TYPES_CONTRIB_REF: update-secrets
  RADIUS_ENV: \${{ inputs.environment || '${env}' }}

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: \${{ inputs.environment || '${env}' }}
    if: \${{ github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success' }}
    steps:
      - uses: actions/checkout@v4

      - name: Build and push application image
        run: |
          set -euo pipefail
          # Build the app container image from the repo Dockerfile and push it to
          # GHCR so the Radius container runs the REAL application instead of a
          # base-image placeholder (a bare base image has no app code or start
          # command and crash-loops, hanging the deploy). The package is private;
          # a pull secret is injected into the deploy namespace below so the
          # target cluster can pull it. Requires an environment secret GHCR_PAT
          # (a PAT with write:packages). Skipped when the repo has no Dockerfile.
          if [ ! -f Dockerfile ]; then
            echo "No Dockerfile found; skipping image build (app.bicep default image will be used)"
            exit 0
          fi
          if [ -z "\${{ secrets.GHCR_PAT }}" ]; then
            echo "❌ GHCR_PAT secret is not set. Add a PAT with write:packages as an environment secret named GHCR_PAT." >&2
            exit 1
          fi
          IMAGE_BASE="ghcr.io/\$(echo '\${{ github.repository }}' | tr '[:upper:]' '[:lower:]')"
          IMAGE="\${IMAGE_BASE}:\${{ github.sha }}"
          echo "\${{ secrets.GHCR_PAT }}" | docker login ghcr.io -u "\${{ github.actor }}" --password-stdin
          docker build -t "\$IMAGE" -t "\${IMAGE_BASE}:latest" .
          docker push "\$IMAGE"
          docker push "\${IMAGE_BASE}:latest"
          echo "APP_IMAGE=\$IMAGE" >> "\$GITHUB_ENV"
          echo "✅ Pushed \$IMAGE"
${clusterAuth}
      - name: Install k3d
        env:
          K3D_VERSION: v5.7.4
        run: |
          # Download a pinned, released k3d binary instead of piping a remote
          # install script into bash, so the install is deterministic and not
          # subject to upstream script changes.
          curl -sfL -o /tmp/k3d "https://github.com/k3d-io/k3d/releases/download/\${K3D_VERSION}/k3d-linux-amd64"
          sudo install -m 0755 /tmp/k3d /usr/local/bin/k3d
          k3d version

      - name: Create k3d cluster for Radius control plane
        run: |
          for attempt in 1 2 3; do
            if k3d cluster create radius-cp --no-lb --wait; then
              break
            fi
            echo "k3d cluster creation attempt \$attempt failed; retrying..."
            k3d cluster delete radius-cp || true
            sleep 10
          done
          k3d cluster list | grep -q radius-cp

      - name: Install Radius CLI
        run: |
          for attempt in 1 2 3; do
            if wget -q "https://raw.githubusercontent.com/radius-project/radius/main/deploy/install.sh" -O /tmp/rad-install.sh && /bin/bash /tmp/rad-install.sh; then
              break
            fi
            echo "Radius CLI install attempt \$attempt failed; retrying..."
            sleep 10
          done
          rad version || { echo "❌ Radius CLI install failed"; exit 1; }

      - name: Install Radius Control Plane on k3d
        run: |
          rad install kubernetes --set rp.publicEndpointOverride=localhost

      - name: Point recipe execution at target cluster
        run: |
          # Mount the static target-cluster kubeconfig into dynamic-rp so that
          # recipe-provisioned resources (containers, databases) land on the
          # TARGET cluster instead of the ephemeral k3d control-plane cluster.
          kubectl create secret generic radius-target-kubeconfig \\
            -n radius-system --from-file=kubeconfig="\$TARGET_KUBECONFIG"
          CN=\$(kubectl get deployment dynamic-rp -n radius-system -o jsonpath='{.spec.template.spec.containers[0].name}')
          kubectl patch deployment dynamic-rp -n radius-system --type strategic -p "{\\"spec\\":{\\"template\\":{\\"spec\\":{\\"containers\\":[{\\"name\\":\\"\$CN\\",\\"env\\":[{\\"name\\":\\"KUBECONFIG\\",\\"value\\":\\"/var/run/target/kubeconfig\\"},{\\"name\\":\\"KUBE_CONFIG_PATH\\",\\"value\\":\\"/var/run/target/kubeconfig\\"}${recipeAuthEnv}],\\"volumeMounts\\":[{\\"name\\":\\"target-kubeconfig\\",\\"mountPath\\":\\"/var/run/target\\",\\"readOnly\\":true}]}],\\"volumes\\":[{\\"name\\":\\"target-kubeconfig\\",\\"secret\\":{\\"secretName\\":\\"radius-target-kubeconfig\\"}}]}}}}"
          kubectl rollout status deployment/dynamic-rp -n radius-system --timeout=180s

      - name: Configure external deployment target
        run: |
          rad workspace create kubernetes default
          rad group create default
          rad group switch default
          rad env create "\${{ env.RADIUS_ENV }}" --namespace "\${{ env.RADIUS_ENV }}"
          rad env switch "\${{ env.RADIUS_ENV }}"
          ${radCredRegister}

      - name: Reset application namespace on target cluster
        run: |
          # Radius creates the app namespace on the (k3d) control-plane cluster,
          # but recipes execute against the target cluster. The k3d control plane
          # (and thus terraform state) is ephemeral, so reset the target app
          # namespace each run to keep deploys idempotent and conflict-free.
          for ns in "\${{ env.RADIUS_ENV }}-\${{ env.RADIUS_ENV }}"; do
            kubectl --kubeconfig "\$TARGET_KUBECONFIG" delete namespace "\$ns" --ignore-not-found --wait=true
          done
          for ns in "\${{ env.RADIUS_ENV }}" "\${{ env.RADIUS_ENV }}-\${{ env.RADIUS_ENV }}"; do
            kubectl --kubeconfig "\$TARGET_KUBECONFIG" create namespace "\$ns" \\
              --dry-run=client -o yaml | kubectl --kubeconfig "\$TARGET_KUBECONFIG" apply -f -
          done
          # If we built a private app image, give the deploy namespace's default
          # service account a GHCR pull secret. Radius schedules container pods
          # under the "default" SA with no imagePullSecrets, so without this the
          # private image can't be pulled on the target cluster.
          if [ -n "\${APP_IMAGE:-}" ]; then
            NS="\${{ env.RADIUS_ENV }}-\${{ env.RADIUS_ENV }}"
            kubectl --kubeconfig "\$TARGET_KUBECONFIG" -n "\$NS" create secret docker-registry ghcr-pull \\
              --docker-server=ghcr.io \\
              --docker-username="\${{ github.actor }}" \\
              --docker-password="\${{ secrets.GHCR_PAT }}" \\
              --dry-run=client -o yaml | kubectl --kubeconfig "\$TARGET_KUBECONFIG" apply -f -
            for i in \$(seq 1 30); do
              kubectl --kubeconfig "\$TARGET_KUBECONFIG" -n "\$NS" get serviceaccount default >/dev/null 2>&1 && break
              sleep 2
            done
            kubectl --kubeconfig "\$TARGET_KUBECONFIG" -n "\$NS" patch serviceaccount default \\
              -p '{"imagePullSecrets":[{"name":"ghcr-pull"}]}'
          fi

      - name: Register resource types and recipes
        run: |
          git clone --depth 1 --branch \${{ env.RESOURCE_TYPES_CONTRIB_REF }} https://github.com/radius-project/resource-types-contrib.git /tmp/rtc
          REF="\${{ env.RESOURCE_TYPES_CONTRIB_REF }}"
          # resource-types-contrib layout: <Category>/<typeName>/<typeName>.yaml
          # with recipes under <Category>/<typeName>/recipes/kubernetes/{terraform,bicep}
          for type_dir in /tmp/rtc/*/*/; do
            type_name=\$(basename "\$type_dir")
            yaml="\${type_dir}\${type_name}.yaml"
            [ -f "\$yaml" ] || continue
            # The database recipe is registered explicitly below (provider-gated,
            # cloud-managed), so skip it in the generic kubernetes recipe loop.
            [ "\$type_name" = "mySqlDatabases" ] && continue
            ns=\$(grep -E '^namespace:' "\$yaml" | head -1 | awk '{print \$2}')
            [ -z "\$ns" ] && continue
            echo "Registering \$ns/\$type_name"
            rad resource-type create -f "\$yaml" || true
            rel=\${type_dir#/tmp/rtc/}
            rel=\${rel%/}
            if [ -d "\${type_dir}recipes/kubernetes/terraform" ]; then
              rad recipe register default \\
                --resource-type "\$ns/\$type_name" \\
                --template-kind terraform \\
                --template-path "git::https://github.com/radius-project/resource-types-contrib.git//\${rel}/recipes/kubernetes/terraform?ref=\${REF}" \\
                --environment "\${{ env.RADIUS_ENV }}" || true
            elif [ -d "\${type_dir}recipes/kubernetes/bicep" ]; then
              rad recipe register default \\
                --resource-type "\$ns/\$type_name" \\
                --template-kind bicep \\
                --template-path "\${type_dir}recipes/kubernetes/bicep" \\
                --environment "\${{ env.RADIUS_ENV }}" || true
            fi
          done
${dbRecipeRegister}
          echo "✅ Resource types and recipes registered"

      - name: Reload control plane to pick up new resource types
        run: |
          # Newly-created (non-default) resource types are not recognised by the
          # deployment engine / UCP until their pods refresh their provider cache.
          kubectl rollout restart deployment -n radius-system
          kubectl rollout status deployment -n radius-system --timeout=240s

      - name: Register custom resource types and recipes (post-reload)
        run: |
          # Repo-local custom resource types (generated on the fly when a type
          # has no recipe in resource-types-contrib, e.g. redisCaches) MUST be
          # registered AFTER the control-plane reload. The reload re-seeds the
          # built-in default registrations (Radius.Compute/*,
          # Radius.Data/mySqlDatabases, Radius.Security/secrets) into each
          # provider's "global" location, OVERWRITING any non-built-in types
          # registered earlier — so registering before the reload would be lost
          # on every (re)run and break the deploy. UCP resolves resource types by
          # reading the location live, so registering here (after the re-seed)
          # makes them routable without another restart. Layout mirrors contrib:
          # .radius/resource-types/<category>/<typeName>/<typeName>.yaml with
          # recipes under <typeName>/recipes/kubernetes/{terraform,bicep}. The
          # recipe is fetched by the deployment engine over git from this repo,
          # so the repo must be public (same constraint as contrib).
          for type_dir in "\$GITHUB_WORKSPACE"/.radius/resource-types/*/*/; do
            [ -d "\$type_dir" ] || continue
            type_name=\$(basename "\$type_dir")
            yaml="\${type_dir}\${type_name}.yaml"
            [ -f "\$yaml" ] || continue
            ns=\$(grep -E '^namespace:' "\$yaml" | head -1 | awk '{print \$2}')
            [ -z "\$ns" ] && continue
            echo "Registering custom \$ns/\$type_name from repo"
            rad resource-type create -f "\$yaml"
            rel=\${type_dir#\$GITHUB_WORKSPACE/}
            rel=\${rel%/}
            if [ -d "\${type_dir}recipes/kubernetes/terraform" ]; then
              rad recipe register default \\
                --resource-type "\$ns/\$type_name" \\
                --template-kind terraform \\
                --template-path "git::https://github.com/\${{ github.repository }}.git//\${rel}/recipes/kubernetes/terraform?ref=\${{ github.sha }}" \\
                --environment "\${{ env.RADIUS_ENV }}"
            elif [ -d "\${type_dir}recipes/kubernetes/bicep" ]; then
              rad recipe register default \\
                --resource-type "\$ns/\$type_name" \\
                --template-kind bicep \\
                --template-path "\${type_dir}recipes/kubernetes/bicep" \\
                --environment "\${{ env.RADIUS_ENV }}"
            fi
          done
          echo "✅ Custom resource types and recipes registered"

      - name: Build Bicep extensions for custom resource types
        run: |
          # Custom resource types (e.g. redisCaches) are not part of the
          # published radius Bicep extension, so Bicep would route them to the
          # Azure ARM provider and fail. Publish a local Bicep extension from
          # each repo-local type manifest so app.bicep can resolve the type and
          # target the Radius control plane. bicepconfig.json references these
          # as ./bicep-extensions/<typeName>.tgz (relative to .radius/).
          mkdir -p .radius/bicep-extensions
          for type_dir in "\$GITHUB_WORKSPACE"/.radius/resource-types/*/*/; do
            [ -d "\$type_dir" ] || continue
            type_name=\$(basename "\$type_dir")
            yaml="\${type_dir}\${type_name}.yaml"
            [ -f "\$yaml" ] || continue
            echo "Publishing Bicep extension for \$type_name"
            rad bicep publish-extension -f "\$yaml" --target ".radius/bicep-extensions/\${type_name}.tgz" --force
          done

      - name: Ensure bicepconfig.json exists
        run: |
          # bicep cannot compile app.bicep (rad deploy) without a bicepconfig.json
          # that registers the Radius extension types. The Radius Canvas extension normally
          # commits this next to app.bicep, but if it is missing at deploy time we
          # synthesize one here so the deployment never fails for a missing config.
          set -uo pipefail
          if [ -f "app.bicep" ]; then CFG_DIR="."; else CFG_DIR=".radius"; fi
          CFG="\$CFG_DIR/bicepconfig.json"
          if [ -f "\$CFG" ]; then
            echo "✅ Found existing \$CFG"
          else
            echo "⚠ \$CFG not found — generating it"
            mkdir -p "\$CFG_DIR"
            {
              echo '{'
              echo '  "experimentalFeaturesEnabled": { "extensibility": true },'
              echo '  "extensions": {'
              # Reference each repo-local custom resource type extension (published as
              # ./bicep-extensions/<typeName>.tgz above) so custom types resolve.
              if [ -d "\$CFG_DIR/bicep-extensions" ]; then
                for tgz in "\$CFG_DIR"/bicep-extensions/*.tgz; do
                  [ -f "\$tgz" ] || continue
                  tname=\$(basename "\$tgz" .tgz)
                  echo "    \\"\$tname\\": \\"./bicep-extensions/\$tname.tgz\\","
                done
              fi
              echo '    "radius": "br:biceptypes.azurecr.io/radius:latest"'
              echo '  }'
              echo '}'
            } > "\$CFG"
            echo "Generated \$CFG:"
            cat "\$CFG"
          fi

      - name: Deploy Application
        run: |
          set -uo pipefail
          # Azure MySQL requires 8-128 chars with 3 of: upper, lower, digit, special.
          DB_PASSWORD="Aa1!\$(openssl rand -hex 16)"
          if [ -f "${appFile}" ]; then APP="${appFile}"; elif [ -f "app.bicep" ]; then APP="app.bicep"; elif [ -f ".radius/app.bicep" ]; then APP=".radius/app.bicep"; else echo "❌ No app.bicep found in repository"; exit 1; fi
          echo "Deploying \$APP"

          LOG="\$RUNNER_TEMP/rad-deploy.log"
          : > "\$LOG"

          # ── Radius control-plane log tail ───────────────────────────────────
          # The Radius control plane runs on the in-runner k3d cluster. Recipe
          # execution (terraform/bicep) and deployment-engine orchestration emit
          # real-time logs from the radius-system pods — a lower-latency, more
          # detailed source than the Azure activity log (and the authoritative
          # place the exact terraform/recipe failure cause is printed).
          CP_LOG="\$RUNNER_TEMP/deploy-controlplane.log"
          : > "\$CP_LOG"
          CP_CTX="k3d-radius-cp"
          start_cp_tail() {
            kubectl config get-contexts "\$CP_CTX" >/dev/null 2>&1 || CP_CTX="\$(kubectl config current-context 2>/dev/null)"
            for d in \$(kubectl --context "\$CP_CTX" -n radius-system get deploy -o name 2>/dev/null); do
              ( kubectl --context "\$CP_CTX" -n radius-system logs "\$d" \\
                  --all-containers=true -f --since=10s --prefix=true 2>/dev/null \\
                | stdbuf -oL grep -iE 'recipe|terraform|tofu|deploymentengine|deployment engine|provision|creating|creation complete|succeeded|completed|processing|updating|destroy|apply|error|fail|azurerm_|aws_|/providers/|radius\.|applications\.' \\
                >> "\$CP_LOG" ) &
            done
          }
          start_cp_tail || true

          # ── Azure activity-log poller ───────────────────────────────────────
          # Captures fine-grained per-resource provisioning status from the
          # target resource group's activity log so the Radius Canvas can color
          # each planned graph node (yellow→green/red) as Azure creates it.
          ACTIVITY_LOG="\$RUNNER_TEMP/deploy-activity.log"
          : > "\$ACTIVITY_LOG"
          ACT_RG="\${{ vars.AZURE_RESOURCE_GROUP }}"
          ACT_START=\$(date -u -d '-2 minutes' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)
          refresh_activity() {
            [ -z "\$ACT_RG" ] && return 0
            az monitor activity-log list \\
              --resource-group "\$ACT_RG" \\
              --start-time "\$ACT_START" \\
              --query "[?resourceId!=null].{status:status.value, rid:resourceId, op:operationName.localizedValue, t:eventTimestamp}" \\
              -o json 2>/dev/null > "\$RUNNER_TEMP/activity-raw.json" || return 0
            jq -r 'sort_by(.t) | .[] | "\\(.status)|\\(.rid)|\\(.op)"' "\$RUNNER_TEMP/activity-raw.json" 2>/dev/null > "\$ACTIVITY_LOG" || true
          }

          # ── Live progress publisher ─────────────────────────────────────────
          # Publishes the growing rad-deploy log AND the activity log to a
          # throwaway branch (radius-deploy-status) so the Radius Canvas can poll
          # real per-resource status in real time. The branch is force-reset on
          # every deploy.
          STATUS_BRANCH="radius-deploy-status"
          STATUS_DIR="\$RUNNER_TEMP/radius-status"
          rm -rf "\$STATUS_DIR"; mkdir -p "\$STATUS_DIR"
          (
            cd "\$STATUS_DIR"
            git init -q
            git checkout -q --orphan "\$STATUS_BRANCH"
            git config user.email "github-actions[bot]@users.noreply.github.com"
            git config user.name "github-actions[bot]"
            git remote add origin "https://x-access-token:\${{ github.token }}@github.com/\${{ github.repository }}.git"
          ) || true
          publish() {
            cp "\$LOG" "\$STATUS_DIR/deploy-progress.log" 2>/dev/null || true
            cp "\$ACTIVITY_LOG" "\$STATUS_DIR/deploy-activity.log" 2>/dev/null || true
            cp "\$CP_LOG" "\$STATUS_DIR/deploy-controlplane.log" 2>/dev/null || true
            printf '%s\\n' "\$1" > "\$STATUS_DIR/deploy-state.txt"
            (
              cd "\$STATUS_DIR"
              git add -A >/dev/null 2>&1 || true
              git commit -q --allow-empty -m "deploy progress: \$1" >/dev/null 2>&1 || true
              git push -q -f origin "\$STATUS_BRANCH" >/dev/null 2>&1 || true
            )
          }

          # ── Run rad deploy in the FOREGROUND, streaming output live ─────────
          # rad deploy runs in the foreground and its combined stdout+stderr is
          # piped through tee so EVERY line (including errors) shows up in the
          # GitHub Actions workflow log in real time for debugging, while also
          # being appended to the live log file the canvas polls. A lightweight
          # background helper publishes periodic status snapshots to the status
          # branch so the canvas's live progress view keeps updating during the
          # deploy.
          DEPLOY_START=\$(date -u +%s)
          echo "▶ Deployment started at \$(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "\$LOG"

          refresh_activity
          publish "in_progress"
          (
            while true; do
              refresh_activity
              publish "in_progress"
              sleep 5
            done
          ) &
          PUB_PID=\$!

          IMG_ARG=""
          [ -n "\${APP_IMAGE:-}" ] && IMG_ARG="-p appImage=\$APP_IMAGE"
          rad deploy "\$APP" --environment "\${{ env.RADIUS_ENV }}" --application "\${{ env.RADIUS_ENV }}" -p dbPassword="\$DB_PASSWORD" \$IMG_ARG 2>&1 | tee -a "\$LOG"
          RAD_EXIT=\${PIPESTATUS[0]}

          kill "\$PUB_PID" 2>/dev/null || true
          wait "\$PUB_PID" 2>/dev/null || true

          DEPLOY_END=\$(date -u +%s)
          echo "■ Deployment finished at \$(date -u +%Y-%m-%dT%H:%M:%SZ) (exit \$RAD_EXIT, \$((DEPLOY_END - DEPLOY_START))s)" | tee -a "\$LOG"

          refresh_activity

          # Capture the deployed application graph and stage it for the status
          # branch so the canvas can render the REAL deployed graph.
          if [ "\$RAD_EXIT" -eq 0 ]; then
            APP_NAME=\$(rad app list -o json 2>/dev/null | jq -r '.[0].name // empty')
            if [ -n "\$APP_NAME" ]; then
              rad app graph -a "\$APP_NAME" -o json > "\$STATUS_DIR/deploy-graph.json" 2>/dev/null || true
            fi
          fi

          # Final publish: write the COMPLETE log + deployed graph, THEN the
          # terminal state marker LAST. Settle and publish twice so the very last
          # bytes reliably land on the status branch before the job exits.
          STATE=\$([ "\$RAD_EXIT" -eq 0 ] && echo "succeeded" || echo "failed")
          publish "\$STATE"
          sleep 4
          publish "\$STATE"

          # rad deploy output already streamed live to this workflow log above
          # (via tee), so no need to re-dump it. On failure, surface the radius
          # control-plane / recipe log too, since that holds the authoritative
          # terraform/recipe failure cause.
          if [ "\$RAD_EXIT" -ne 0 ] && [ -s "\$CP_LOG" ]; then
            echo "──────── radius control-plane / recipe log ────────"
            cat "\$CP_LOG"
          fi
          exit "\$RAD_EXIT"

      - name: Show Application Status
        run: |
          APP_NAME=\$(rad app list -o json | jq -r '.[0].name // empty')
          if [ -n "\$APP_NAME" ]; then
            rad app graph -a "\$APP_NAME"
          else
            echo "No application found after deploy"
          fi
        continue-on-error: true
`;
}
