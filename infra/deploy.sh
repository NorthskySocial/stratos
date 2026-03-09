#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

IMAGE_TAG="${1:-$(git -C "$REPO_ROOT" rev-parse --short HEAD)}"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region || echo "${AWS_DEFAULT_REGION:-us-east-1}")
REGISTRY="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

# Resolve config — uses conf/config.ts if present, falls back to env vars
ENV_NAME=$(node --input-type=module -e "import {resolveConfig} from './src/config.ts'; const c = await resolveConfig(); console.log(c.environment)")
VITE_STRATOS_URL=$(node --input-type=module -e "import {resolveConfig} from './src/config.ts'; const c = await resolveConfig(); console.log(c.webapp.stratosUrl)")
WEBAPP_SUBDOMAIN=$(node --input-type=module -e "import {resolveConfig} from './src/config.ts'; const c = await resolveConfig(); console.log(c.webappSubdomain)")
DOMAIN_NAME=$(node --input-type=module -e "import {resolveConfig} from './src/config.ts'; const c = await resolveConfig(); console.log(c.domainName)")

STRATOS_REPO="$REGISTRY/stratos-$ENV_NAME"
WEBAPP_REPO="$REGISTRY/stratos-webapp-$ENV_NAME"
VITE_WEBAPP_URL="https://${WEBAPP_SUBDOMAIN}.${DOMAIN_NAME}"

echo "==> Deploying with tag: $IMAGE_TAG"
echo "    Account:  $ACCOUNT_ID"
echo "    Region:   $REGION"
echo "    Env:      $ENV_NAME"

# Authenticate Docker with ECR
echo "==> Logging in to ECR..."
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

# Deploy network stack first (creates ECR repos if they don't exist)
echo "==> Deploying network stack..."
cd "$SCRIPT_DIR"
npx cdk deploy "Stratos-Network-$ENV_NAME" --require-approval never

# Build and push stratos image
echo "==> Building stratos image..."
docker build \
  --platform linux/arm64 \
  -f "$REPO_ROOT/Dockerfile" \
  -t "$STRATOS_REPO:$IMAGE_TAG" \
  "$REPO_ROOT"

echo "==> Pushing stratos image..."
docker push "$STRATOS_REPO:$IMAGE_TAG"
STRATOS_DIGEST=$(aws ecr describe-images --repository-name "stratos-$ENV_NAME" --image-ids imageTag="$IMAGE_TAG" --region "$REGION" --query 'imageDetails[0].imageDigest' --output text)
echo "    Digest: $STRATOS_DIGEST"

# Build and push webapp image
echo "==> Building webapp image..."
docker build \
  --platform linux/arm64 \
  -f "$REPO_ROOT/webapp/Dockerfile" \
  --build-arg "VITE_STRATOS_URL=$VITE_STRATOS_URL" \
  --build-arg "VITE_WEBAPP_URL=$VITE_WEBAPP_URL" \
  -t "$WEBAPP_REPO:$IMAGE_TAG" \
  "$REPO_ROOT"

echo "==> Pushing webapp image..."
docker push "$WEBAPP_REPO:$IMAGE_TAG"
WEBAPP_DIGEST=$(aws ecr describe-images --repository-name "stratos-webapp-$ENV_NAME" --image-ids imageTag="$IMAGE_TAG" --region "$REGION" --query 'imageDetails[0].imageDigest' --output text)
echo "    Digest: $WEBAPP_DIGEST"

# Deploy service stacks with the image tag and digests
# Digests force a new ECS deployment even when the tag is unchanged
echo "==> Deploying service stacks..."
cd "$SCRIPT_DIR"
npx cdk deploy --all --require-approval never \
  --context "imageTag=$IMAGE_TAG" \
  --context "stratosImageDigest=$STRATOS_DIGEST" \
  --context "webappImageDigest=$WEBAPP_DIGEST"

echo "==> Deploy complete! (tag: $IMAGE_TAG)"
