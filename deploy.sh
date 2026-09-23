#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

# ============================================================
# Amazon Connect Agent Performance Analyzer - CloudFormation Deploy
# ============================================================
#
# Deploys (or destroys) the full stack using AWS CloudFormation.
#
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh [OPTIONS]
#
# Options:
#   --region <region>       AWS region (default: us-east-1)
#   --environment <env>     Environment: dev, staging, prod (default: dev)
#   --profile <profile>     AWS CLI profile to use
#   --stack-name <name>     CloudFormation stack name override
#   --destroy               Tear down all resources
#   --skip-frontend         Skip frontend build and upload
#   --auto-approve          Skip interactive approval prompts
#   --help                  Show this help message
#
# ============================================================

set -euo pipefail

# ─────────────────────────────────────────────────────────────
# Colors
# ─────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

PASS="${GREEN}✔${NC}"
FAIL="${RED}✘${NC}"
WARN="${YELLOW}⚠${NC}"
INFO="${BLUE}ℹ${NC}"
ARROW="${CYAN}→${NC}"

log_info()    { printf '%b\n' "  ${INFO}  $1"; }
log_success() { printf '%b\n' "  ${PASS}  $1"; }
log_warn()    { printf '%b\n' "  ${WARN}  $1"; }
log_error()   { printf '%b\n' "  ${FAIL}  $1"; }
log_step()    { printf '\n%b\n' "${ARROW} ${BOLD}$1${NC}"; }

banner() {
  printf '\n'
  printf '%b\n' "${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
  printf '%b\n' "${CYAN}║${NC}  ${BOLD}Amazon Connect Agent Analyzer - CloudFormation Deploy${NC}    ${CYAN}║${NC}"
  printf '%b\n' "${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"
  printf '\n'
}

usage() {
  echo "Usage: $0 [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  --region <region>       AWS region (default: us-east-1)"
  echo "  --environment <env>     Environment: dev, staging, prod (default: dev)"
  echo "  --profile <profile>     AWS CLI profile to use"
  echo "  --stack-name <name>     CloudFormation stack name override"
  echo "  --destroy               Tear down all resources"
  echo "  --skip-frontend         Skip frontend build and upload"
  echo "  --auto-approve          Skip interactive approval prompts"
  echo "  --help                  Show this help message"
  echo ""
  echo "Examples:"
  echo "  $0                                    # Deploy with defaults (interactive)"
  echo "  $0 --profile my-account --region us-west-2"
  echo "  $0 --destroy --auto-approve           # Teardown without prompts"
  exit 0
}

cleanup() {
  local exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    printf '\n'
    log_error "Deployment failed with exit code ${exit_code}"
    log_info  "Check the output above for details"
  fi
}
trap cleanup EXIT

# ─────────────────────────────────────────────────────────────
# Parse arguments
# ─────────────────────────────────────────────────────────────
REGION="${AWS_REGION:-us-east-1}"
ENVIRONMENT="dev"
AWS_PROFILE_ARG=""
STACK_NAME_OVERRIDE=""
DESTROY=false
SKIP_FRONTEND=false
AUTO_APPROVE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --region)        REGION="$2"; shift 2 ;;
    --environment)   ENVIRONMENT="$2"; shift 2 ;;
    --profile)       AWS_PROFILE_ARG="$2"; shift 2 ;;
    --stack-name)    STACK_NAME_OVERRIDE="$2"; shift 2 ;;
    --destroy)       DESTROY=true; shift ;;
    --skip-frontend) SKIP_FRONTEND=true; shift ;;
    --auto-approve)  AUTO_APPROVE=true; shift ;;
    --help|-h)       usage ;;
    *)               log_error "Unknown option: $1"; echo "  Run $0 --help for usage"; exit 1 ;;
  esac
done

if [[ -n "$AWS_PROFILE_ARG" ]]; then
  export AWS_PROFILE="$AWS_PROFILE_ARG"
fi
export AWS_DEFAULT_REGION="$REGION"

# Resolve paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_FILE="${SCRIPT_DIR}/template.yaml"
LAMBDA_DIR="${SCRIPT_DIR}/lambda-python"
FRONTEND_DIR="${SCRIPT_DIR}/frontend"
CONFIG_FILE="${CONFIG_FILE:-${SCRIPT_DIR}/config.txt}"

# ─────────────────────────────────────────────────────────────
# config.txt loader
# ─────────────────────────────────────────────────────────────
# Reads deployment inputs from a simple "Key: value" file (config.txt) so both
# deploy.sh (CloudFormation) and deploy-terraform.sh consume the same source of
# truth. Recognized keys (case/spacing tolerant):
#   Connect Instance   -> CONNECT_INSTANCE_ID
#   QConnect Assistant -> QCONNECT_ASSISTANT_ID
#   Recording Bucket   -> CONNECT_RECORDING_BUCKET
#   ADMIN_EMAIL        -> ADMIN_EMAIL
# Existing environment variables take precedence over the file (so callers can
# override without editing config.txt).
load_config() {
  [[ -f "$CONFIG_FILE" ]] || return 0
  local key val norm
  while IFS= read -r line || [[ -n "$line" ]]; do
    # Skip blank lines and comments.
    [[ -z "${line// }" ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" == *:* ]] || continue
    key="${line%%:*}"
    val="${line#*:}"
    # Trim surrounding whitespace.
    key="$(echo "$key" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    val="$(echo "$val" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    # Normalize key: lowercase, drop non-alphanumerics.
    norm="$(echo "$key" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]')"
    case "$norm" in
      connectinstance|connectinstanceid)      CONNECT_INSTANCE_ID="${CONNECT_INSTANCE_ID:-$val}" ;;
      qconnectassistant|qconnectassistantid)   QCONNECT_ASSISTANT_ID="${QCONNECT_ASSISTANT_ID:-$val}" ;;
      recordingbucket|connectrecordingbucket)  CONNECT_RECORDING_BUCKET="${CONNECT_RECORDING_BUCKET:-$val}" ;;
      adminemail)                               ADMIN_EMAIL="${ADMIN_EMAIL:-$val}" ;;
    esac
  done < "$CONFIG_FILE"
}
load_config

# ─────────────────────────────────────────────────────────────
# Prerequisites
# ─────────────────────────────────────────────────────────────
banner

log_step "Checking prerequisites"

for cmd in aws node npm python3 zip; do
  if ! command -v "$cmd" &>/dev/null; then
    log_error "Required command not found: ${cmd}"
    exit 1
  fi
done
log_success "All required tools installed"

# Validate AWS credentials
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) || {
  log_error "AWS credentials not configured. Run 'aws configure' or export AWS_PROFILE."
  exit 1
}
log_success "AWS Account: ${ACCOUNT_ID} | Region: ${REGION}"

# Stack name
PROJECT_NAME="connect-analyzer"
STACK_NAME="${STACK_NAME_OVERRIDE:-${PROJECT_NAME}-${ENVIRONMENT}}"

# ─────────────────────────────────────────────────────────────
# Destroy path
# ─────────────────────────────────────────────────────────────
if [[ "$DESTROY" == true ]]; then
  log_step "Destroying stack: ${STACK_NAME}"

  if [[ "$AUTO_APPROVE" != true ]]; then
    printf '\n'
    printf '%b\n' "  ${RED}${BOLD}WARNING:${NC} This will destroy ALL resources in stack ${STACK_NAME}"
    printf '%b\n' "  Account: ${ACCOUNT_ID} | Region: ${REGION}"
    printf '\n'
    read -r -p "  Type 'destroy' to confirm: " CONFIRM
    if [[ "$CONFIRM" != "destroy" ]]; then
      log_info "Aborted."
      exit 0
    fi
  fi

  # Empty the frontend S3 bucket first
  S3_BUCKET=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='FrontendBucketName'].OutputValue" \
    --output text 2>/dev/null || true)

  if [[ -n "$S3_BUCKET" && "$S3_BUCKET" != "None" ]]; then
    log_info "Emptying frontend bucket: ${S3_BUCKET}"
    aws s3 rm "s3://${S3_BUCKET}" --recursive 2>/dev/null || true
    # Delete all versions for versioned bucket
    aws s3api list-object-versions --bucket "$S3_BUCKET" --output json 2>/dev/null | \
      python3 -c "
import json, sys, subprocess
data = json.load(sys.stdin)
objects = [{'Key':v['Key'],'VersionId':v['VersionId']} for v in data.get('Versions',[])]
objects += [{'Key':d['Key'],'VersionId':d['VersionId']} for d in data.get('DeleteMarkers',[])]
if objects:
    bucket = '${S3_BUCKET}'
    for i in range(0, len(objects), 1000):
        batch = objects[i:i+1000]
        payload = json.dumps({'Objects': batch, 'Quiet': True})
        subprocess.run(['aws','s3api','delete-objects','--bucket',bucket,'--delete',payload], capture_output=True)
    print(f'Deleted {len(objects)} versions/markers')
" 2>/dev/null || true
    log_success "Bucket emptied"
  fi

  # Remove S3 notification from recording bucket
  RECORDING_BUCKET=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Parameters[?ParameterKey=='ConnectRecordingBucket'].ParameterValue" \
    --output text 2>/dev/null || true)
  if [[ -n "$RECORDING_BUCKET" && "$RECORDING_BUCKET" != "None" ]]; then
    log_info "Removing S3 event notification from ${RECORDING_BUCKET}"
    aws s3api put-bucket-notification-configuration --bucket "$RECORDING_BUCKET" \
      --notification-configuration '{"LambdaFunctionConfigurations":[]}' 2>/dev/null || true
  fi

  # Delete the Lambda deployment bucket
  DEPLOY_BUCKET="${PROJECT_NAME}-${ENVIRONMENT}-deploy-${ACCOUNT_ID}-${REGION}"
  if aws s3api head-bucket --bucket "$DEPLOY_BUCKET" 2>/dev/null; then
    log_info "Emptying deployment bucket: ${DEPLOY_BUCKET}"
    aws s3 rm "s3://${DEPLOY_BUCKET}" --recursive 2>/dev/null || true
    aws s3api delete-bucket --bucket "$DEPLOY_BUCKET" 2>/dev/null || true
    log_success "Deployment bucket deleted"
  fi

  # Delete the stack
  aws cloudformation delete-stack --stack-name "$STACK_NAME"
  log_info "Waiting for stack deletion..."
  aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME"
  log_success "Stack ${STACK_NAME} destroyed"

  # Clean local artifacts
  rm -rf "${LAMBDA_DIR}/package" "${LAMBDA_DIR}/lambda.zip" 2>/dev/null || true
  rm -rf "${FRONTEND_DIR}/node_modules" "${FRONTEND_DIR}/build" "${FRONTEND_DIR}/.env" 2>/dev/null || true
  rm -f "${SCRIPT_DIR}/packaged-template.yaml" 2>/dev/null || true
  log_success "Local artifacts cleaned"
  exit 0
fi

# ─────────────────────────────────────────────────────────────
# Collect parameters (interactive or from env)
# ─────────────────────────────────────────────────────────────
log_step "Collecting deployment parameters"

# Check if stack already exists (for updates)
STACK_EXISTS=false
if aws cloudformation describe-stacks --stack-name "$STACK_NAME" &>/dev/null; then
  STACK_EXISTS=true
  log_info "Existing stack found - will update"
fi

if [[ "$STACK_EXISTS" == true ]]; then
  # Pull existing parameters for update
  CONNECT_INSTANCE_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Parameters[?ParameterKey=='ConnectInstanceId'].ParameterValue" --output text)
  QCONNECT_ASSISTANT_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Parameters[?ParameterKey=='QConnectAssistantId'].ParameterValue" --output text)
  CONNECT_RECORDING_BUCKET=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Parameters[?ParameterKey=='ConnectRecordingBucket'].ParameterValue" --output text)
  log_success "Using existing stack parameters"
else
  # Prompt for required values
  if [[ -z "${CONNECT_INSTANCE_ID:-}" ]]; then
    read -r -p "  Connect Instance ID (UUID): " CONNECT_INSTANCE_ID
    while [[ ! "$CONNECT_INSTANCE_ID" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]]; do
      log_error "Invalid UUID. Example: 12345678-abcd-1234-efgh-123456789012"
      read -r -p "  Connect Instance ID (UUID): " CONNECT_INSTANCE_ID
    done
  fi

  if [[ -z "${QCONNECT_ASSISTANT_ID:-}" ]]; then
    read -r -p "  QConnect Assistant ID (UUID): " QCONNECT_ASSISTANT_ID
    while [[ ! "$QCONNECT_ASSISTANT_ID" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]]; do
      log_error "Invalid UUID. Example: abcdef01-2345-6789-abcd-ef0123456789"
      read -r -p "  QConnect Assistant ID (UUID): " QCONNECT_ASSISTANT_ID
    done
  fi

  if [[ -z "${CONNECT_RECORDING_BUCKET:-}" ]]; then
    read -r -p "  Connect Recording Bucket name: " CONNECT_RECORDING_BUCKET
    while [[ -z "$CONNECT_RECORDING_BUCKET" ]]; do
      log_error "Bucket name cannot be empty"
      read -r -p "  Connect Recording Bucket name: " CONNECT_RECORDING_BUCKET
    done
  fi
fi

log_success "Connect Instance: ${CONNECT_INSTANCE_ID}"
log_success "QConnect Assistant: ${QCONNECT_ASSISTANT_ID}"
log_success "Recording Bucket: ${CONNECT_RECORDING_BUCKET}"
log_success "Admin Email: ${ADMIN_EMAIL:-admin@example.com}"

# ─────────────────────────────────────────────────────────────
# Step 1: Package Lambda
# ─────────────────────────────────────────────────────────────
log_step "Packaging Lambda function"

cd "$LAMBDA_DIR"
rm -rf package lambda.zip 2>/dev/null || true

# Install boto3 (pinned version with ListSpans timeToFirstTokenMs support)
pip3 install --target ./package boto3==1.43.44 --quiet
log_success "boto3 installed to package/"

# Create zip
cd package && zip -r9 ../lambda.zip . -x "*.pyc" "__pycache__/*" > /dev/null
cd "$LAMBDA_DIR" && zip -g lambda.zip handler.py pipeline.py > /dev/null
zip -gr lambda.zip steps/ -x "*.pyc" "__pycache__/*" > /dev/null
LAMBDA_SIZE=$(du -sh lambda.zip | cut -f1)
log_success "Lambda package created: lambda.zip (${LAMBDA_SIZE})"

cd "$SCRIPT_DIR"

# ─────────────────────────────────────────────────────────────
# Step 2: Deploy CloudFormation stack
# ─────────────────────────────────────────────────────────────
log_step "Deploying CloudFormation stack: ${STACK_NAME}"

# Use cloudformation package to upload Lambda zip to a managed artifact bucket
DEPLOY_BUCKET="${PROJECT_NAME}-${ENVIRONMENT}-deploy-${ACCOUNT_ID}-${REGION}"
if ! aws s3api head-bucket --bucket "$DEPLOY_BUCKET" 2>/dev/null; then
  aws s3api create-bucket --bucket "$DEPLOY_BUCKET" --region "$REGION" \
    $(if [[ "$REGION" != "us-east-1" ]]; then echo "--create-bucket-configuration LocationConstraint=$REGION"; fi) \
    > /dev/null
  aws s3api put-public-access-block --bucket "$DEPLOY_BUCKET" \
    --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" \
    > /dev/null
fi

aws cloudformation package \
  --template-file "$TEMPLATE_FILE" \
  --s3-bucket "$DEPLOY_BUCKET" \
  --output-template-file "${SCRIPT_DIR}/packaged-template.yaml" \
  > /dev/null

log_success "Template packaged (Lambda uploaded to deployment bucket)"

# Resolve the Q Connect assistant's KMS key ARN so the Lambda can be granted
# kms:Decrypt (needed for ListAIAgents / GetAIAgent -> agent name resolution).
# Precedence: explicit QCONNECT_KMS_KEY_ARN env var > auto-detected from the assistant
# > value already stored on the stack (so it is retained across deploys).
EXISTING_QCONNECT_KMS_KEY_ARN=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Parameters[?ParameterKey=='QConnectKmsKeyArn'].ParameterValue" \
  --output text 2>/dev/null || true)
if [[ -z "$EXISTING_QCONNECT_KMS_KEY_ARN" || "$EXISTING_QCONNECT_KMS_KEY_ARN" == "None" ]]; then
  EXISTING_QCONNECT_KMS_KEY_ARN=""
fi
if [[ -z "${QCONNECT_KMS_KEY_ARN:-}" && -z "$EXISTING_QCONNECT_KMS_KEY_ARN" ]]; then
  DETECTED_QCONNECT_KMS_KEY_ARN=$(aws qconnect get-assistant --assistant-id "$QCONNECT_ASSISTANT_ID" \
    --query "assistant.serverSideEncryptionConfiguration.kmsKeyId" --output text 2>/dev/null || true)
  if [[ -n "$DETECTED_QCONNECT_KMS_KEY_ARN" && "$DETECTED_QCONNECT_KMS_KEY_ARN" != "None" ]]; then
    EXISTING_QCONNECT_KMS_KEY_ARN="$DETECTED_QCONNECT_KMS_KEY_ARN"
    log_success "Detected Q Connect KMS key: $EXISTING_QCONNECT_KMS_KEY_ARN"
  fi
fi

aws cloudformation deploy \
  --template-file "${SCRIPT_DIR}/packaged-template.yaml" \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ProjectName="$PROJECT_NAME" \
    Environment="$ENVIRONMENT" \
    ConnectInstanceId="$CONNECT_INSTANCE_ID" \
    QConnectAssistantId="$QCONNECT_ASSISTANT_ID" \
    ConnectRecordingBucket="$CONNECT_RECORDING_BUCKET" \
    EnableAuthenticatedAccess="true" \
    CorrelationLookbackDays="${CORRELATION_LOOKBACK_DAYS:-7}" \
    QConnectKmsKeyArn="${QCONNECT_KMS_KEY_ARN:-$EXISTING_QCONNECT_KMS_KEY_ARN}" \
    AdminEmail="${ADMIN_EMAIL:-admin@example.com}" \
  --no-fail-on-empty-changeset

log_success "Stack deployed successfully"

# ─────────────────────────────────────────────────────────────
# Step 3: Configure S3 event notification on recording bucket
# ─────────────────────────────────────────────────────────────
log_step "Configuring S3 event notification"

LAMBDA_ARN=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='LambdaFunctionArn'].OutputValue" --output text)

# Set the notification configuration
NOTIFICATION_CONFIG=$(cat <<EOF
{
  "LambdaFunctionConfigurations": [
    {
      "LambdaFunctionArn": "${LAMBDA_ARN}",
      "Events": ["s3:ObjectCreated:*"],
      "Filter": {
        "Key": {
          "FilterRules": [
            {"Name": "prefix", "Value": "Analysis/Voice/ivr/"},
            {"Name": "suffix", "Value": ".json"}
          ]
        }
      }
    }
  ]
}
EOF
)

if aws s3api put-bucket-notification-configuration \
  --bucket "$CONNECT_RECORDING_BUCKET" \
  --notification-configuration "$NOTIFICATION_CONFIG" 2>/dev/null; then
  log_success "S3 notification configured on ${CONNECT_RECORDING_BUCKET}"
else
  log_warn "Could not configure S3 notification on ${CONNECT_RECORDING_BUCKET}"
  log_info "If the bucket is in another account, configure the notification manually:"
  log_info "  Lambda ARN: ${LAMBDA_ARN}"
  log_info "  Prefix: Analysis/Voice/ivr/  |  Suffix: .json"
fi

# ─────────────────────────────────────────────────────────────
# Step 4: Cognito admin user
# ─────────────────────────────────────────────────────────────
# The admin user is created by CloudFormation (CognitoAdminUser custom resource, backed
# by an inline Lambda that calls admin-create-user idempotently) from the AdminEmail
# parameter, and Cognito emails the temporary password. Self sign-up is disabled on the
# pool.
log_step "Configuring Cognito"

USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='CognitoUserPoolId'].OutputValue" --output text 2>/dev/null || echo "")

if [[ -n "$USER_POOL_ID" && "$USER_POOL_ID" != "None" ]]; then
  log_success "Admin user managed by CloudFormation: ${ADMIN_EMAIL:-admin@example.com}"
  log_info "Cognito emails a temporary password to that address on first creation."
else
  log_info "No User Pool found (unauthenticated mode)"
fi

# ─────────────────────────────────────────────────────────────
# Step 5: Build and deploy frontend
# ─────────────────────────────────────────────────────────────
if [[ "$SKIP_FRONTEND" == true ]]; then
  log_step "Skipping frontend (--skip-frontend)"
else
  log_step "Building and deploying frontend"

  # Get stack outputs
  IDENTITY_POOL_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='CognitoIdentityPoolId'].OutputValue" --output text)
  DYNAMODB_TABLE=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='SessionsTableName'].OutputValue" --output text)
  AGENTS_TABLE=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='AgentsTableName'].OutputValue" --output text)
  S3_BUCKET=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='FrontendBucketName'].OutputValue" --output text)
  USER_POOL_CLIENT_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='CognitoUserPoolClientId'].OutputValue" --output text 2>/dev/null || echo "")

  # Write .env file for React build
  cat > "${FRONTEND_DIR}/.env" <<EOF
REACT_APP_AWS_REGION=${REGION}
REACT_APP_IDENTITY_POOL_ID=${IDENTITY_POOL_ID}
REACT_APP_DYNAMODB_TABLE_NAME=${DYNAMODB_TABLE}
REACT_APP_AGENTS_TABLE_NAME=${AGENTS_TABLE}
REACT_APP_USER_POOL_ID=${USER_POOL_ID:-}
REACT_APP_USER_POOL_CLIENT_ID=${USER_POOL_CLIENT_ID:-}
REACT_APP_QCONNECT_ASSISTANT_ID=${QCONNECT_ASSISTANT_ID}
EOF
  log_success "Frontend .env generated"

  # Build
  cd "$FRONTEND_DIR"
  npm install --legacy-peer-deps --silent 2>/dev/null || npm install --legacy-peer-deps
  NODE_OPTIONS=--openssl-legacy-provider npm run build
  log_success "Frontend built"

  # Upload to S3
  aws s3 sync build/ "s3://${S3_BUCKET}/" \
    --delete \
    --cache-control "public, max-age=31536000, immutable" \
    --exclude "index.html" \
    --exclude "asset-manifest.json" \
    --quiet

  aws s3 cp build/index.html "s3://${S3_BUCKET}/index.html" \
    --cache-control "no-cache, no-store, must-revalidate" \
    --quiet

  if [[ -f build/asset-manifest.json ]]; then
    aws s3 cp build/asset-manifest.json "s3://${S3_BUCKET}/asset-manifest.json" \
      --cache-control "no-cache, no-store, must-revalidate" \
      --quiet
  fi

  log_success "Frontend uploaded to S3"

  # CloudFront invalidation
  CF_DIST_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDistributionId'].OutputValue" --output text 2>/dev/null || true)

  if [[ -n "$CF_DIST_ID" && "$CF_DIST_ID" != "None" ]]; then
    aws cloudfront create-invalidation --distribution-id "$CF_DIST_ID" --paths "/*" > /dev/null
    log_success "CloudFront cache invalidated"
  fi

  cd "$SCRIPT_DIR"
fi

# ─────────────────────────────────────────────────────────────
# Done
# ─────────────────────────────────────────────────────────────
log_step "Deployment complete!"

CLOUDFRONT_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontURL'].OutputValue" --output text)

printf '\n'
log_success "Dashboard URL: ${CLOUDFRONT_URL}"
if [[ -n "${USER_POOL_ID:-}" && "$USER_POOL_ID" != "None" ]]; then
  printf '\n'
  printf '%b\n' "  ${BOLD}Login:${NC}"
  log_info "Email: ${ADMIN_EMAIL:-admin@example.com}"
  log_info "Cognito emailed a temporary password to that address on first creation."
  log_info "Sign in and you will be prompted to set a new password. Self sign-up is disabled."
  printf '\n'
  log_info "If the email did not arrive, resend the invite with:"
  printf '\n'
  printf '%s\n' "    aws cognito-idp admin-create-user \\"
  printf '%s\n' "      --user-pool-id ${USER_POOL_ID} \\"
  printf '%s\n' "      --username ${ADMIN_EMAIL:-admin@example.com} \\"
  printf '%s\n' "      --message-action RESEND \\"
  printf '%s\n' "      --region ${REGION}"
  printf '\n'
fi
printf '\n'
