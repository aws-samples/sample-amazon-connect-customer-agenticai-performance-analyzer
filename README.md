# Amazon Connect AI Agent Performance Analyzer

When you deploy AI agents in Amazon Connect using Connect Agentic, understanding how they perform in real customer conversations is critical. How long are customers actually waiting for a response? Where is the latency coming from — the LLM, tool execution, speech processing, or orchestration overhead? Is one model faster than another for your use case? Are there PII handling issues in agent responses?

This tool answers those questions by providing deep, turn-by-turn performance visibility into your AI agent interactions.

## Why This Tool

Amazon Connect and Connect Agentic provide powerful agentic capabilities, but observability into the real-time performance characteristics of AI agent conversations is limited out of the box. Contact center leaders and developers need to understand:

- **Customer-perceived latency** — The actual silence a customer experiences between finishing their question and hearing the agent respond. This is the metric that matters most for customer experience, and it is not surfaced directly in the standard Amazon Connect dashboards.

- **Latency decomposition** — Breaking down each turn into its components: Speech-to-Text (STT), orchestration overhead, Time to First Token (TTFT), LLM inference, tool execution, and Text-to-Speech (TTS). Without this breakdown, you can't identify which component to optimize. (STT and TTS are reported together as a single Speech Processing metric because true per-component TTS is not measurable from the source data — see [Latency Metric Methodology](#latency-metric-methodology).)

- **Model comparison** — When evaluating different foundation models (Claude, Nova, etc.) for your agents, you need side-by-side latency and token usage data from real production conversations, not synthetic benchmarks.

- **Tool execution impact** — Understanding how third-party tool calls (knowledge base lookups, API calls, database queries) affect end-to-end response time versus turns that only require LLM reasoning.

- **PII handling verification** — Detecting when an agent echoes back customer PII (phone numbers, emails, account numbers) differently than what the customer actually said, which can indicate STT errors or agent hallucinations.

- **Prompt caching effectiveness** — Measuring whether prompt caching is actually reducing token costs and latency across conversation turns.

- **Anomaly detection** — Identifying barge-ins (customer or agent interruptions), long customer pauses, and other conversational patterns that affect performance measurements.

## What You Get

- **Session comparison** — Compare up to 10 conversations side-by-side with full per-turn timing breakdowns
- **Aggregated statistics** — P50, P90, P99 percentile distributions across all latency dimensions
- **Per-turn interaction analysis** — Visual timeline showing exactly what happened in each conversational turn
- **Model and agent filtering** — Filter by AI agent, foundation model, voice engine, and date range
- **CSV export** — Export raw data for further analysis in your own tools
- **Automated pipeline** — Fully event-driven: data flows automatically from Contact Lens to the dashboard with no manual steps

## Architecture

![Reference Architecture](Reference%20Architecture.png)

1. **Trigger** — Contact Lens writes post-call analysis JSON to S3 (`Analysis/Voice/ivr/...`). It produces two files per contact — an unredacted and a redacted transcript — and both trigger the Lambda. The pipeline keeps a single DynamoDB record per contact and always prefers the unredacted data: an unredacted file overwrites any existing record, while a redacted file is only stored if no unredacted record exists yet (enforced with a conditional write, so arrival order does not matter). PII-mismatch detection runs only on unredacted transcripts.
2. **Lambda pipeline** — Downloads the file, correlates with a QConnect session via CloudWatch Logs, retrieves spans, calculates per-turn latency metrics, and writes a consolidated record to DynamoDB
3. **Frontend** — React app authenticates via Cognito, reads DynamoDB directly using temporary credentials, and renders performance dashboards

## Prerequisites

- AWS CLI v2 configured with appropriate credentials
- Node.js 18+ and npm
- Python 3.14+ and pip3
- An existing Amazon Connect instance with:
  - Contact Lens enabled (writes to an S3 bucket)
  - Amazon Q in Connect (QConnect) assistant configured

## Project Structure

```
.
├── config.txt                 # Deployment inputs read by deploy.sh
├── template.yaml              # CloudFormation template (all infrastructure)
├── deploy.sh                  # CloudFormation deploy/destroy script
├── .gitignore
├── lambda-python/             # Lambda function source (Python 3.14)
│   ├── handler.py             # S3 event entry point
│   ├── pipeline.py            # 8-step processing pipeline
│   └── steps/                 # Individual pipeline steps
│       ├── download_file.py
│       ├── correlate_session.py
│       ├── retrieve_spans.py
│       ├── calculate_metrics.py
│       ├── resolve_agent.py
│       ├── resolve_voice.py
│       └── write_records.py
└── frontend/                  # React frontend (Cloudscape UI + Chart.js)
    ├── .env.example           # Environment variable reference
    ├── package.json
    ├── public/
    └── src/
        ├── config.ts          # All config from environment variables
        ├── App.tsx            # Main application
        ├── auth/              # Cognito authentication
        └── services/          # DynamoDB data access
```

## Quick Start

### 1. Fill in `config.txt`

`deploy.sh` reads its inputs from a single `config.txt` file in the project root.
Edit it with your values:

```
Connect Instance: 12345678-abcd-1234-efgh-123456789012
QConnect Assistant: abcdef01-2345-6789-abcd-ef0123456789
Recording Bucket: your-connect-recordings-bucket
ADMIN_EMAIL: you@example.com
```

- **Connect Instance** — UUID from the Amazon Connect console
- **QConnect Assistant** — UUID from Amazon Q in Connect settings
- **Recording Bucket** — existing S3 bucket where Contact Lens writes analysis files
- **ADMIN_EMAIL** — email for the initial dashboard user; Cognito emails a temporary
  password to this address (self sign-up is disabled)

Keys are case- and spacing-tolerant. Any value can be overridden with an environment
variable of the same name (`CONNECT_INSTANCE_ID`, `QCONNECT_ASSISTANT_ID`,
`CONNECT_RECORDING_BUCKET`, `ADMIN_EMAIL`).

### 2. Deploy

```bash
chmod +x deploy.sh
./deploy.sh
```

The script automatically:
1. Packages the Lambda function with dependencies (boto3)
2. Deploys the CloudFormation stack
3. Configures the S3 event notification on the recording bucket
4. Creates the admin Cognito user — **Cognito emails a temporary password** to
   `ADMIN_EMAIL`; self sign-up is disabled so only admins can add users
5. Builds the React frontend with the stack outputs
6. Uploads the frontend to S3 and invalidates CloudFront

At the end it prints the dashboard URL. Sign in with `ADMIN_EMAIL` and the temporary
password from the email; you will be prompted to set a permanent password on first
login. See [Managing Users](#managing-users) to resend an invite or add users.

### Deploy with options

```bash
# Specify region and AWS profile
./deploy.sh --region us-west-2 --profile my-aws-profile

# Non-interactive
./deploy.sh --auto-approve

# Update only infrastructure (skip frontend rebuild/upload)
./deploy.sh --skip-frontend

# Point at a different config file
CONFIG_FILE=./config.prod.txt ./deploy.sh --auto-approve

# Custom stack name / environment
./deploy.sh --stack-name my-analyzer-prod --environment prod
```

### Updating an existing deployment

For a normal update, just re-run `./deploy.sh` — it packages the latest Lambda and
frontend and updates the CloudFormation stack in place.

**Upgrading from an older version?** The Cognito admin user is now managed by
CloudFormation (a custom resource that calls `admin-create-user` idempotently). An
earlier version of this template created the admin user with a native
`AWS::Cognito::UserPoolUser` resource. Because the User Pool uses **email as the
username**, that native resource is invalid — Cognito requires the physical username
to be a system-assigned UUID, so every stack update failed with
`Value at 'username' failed to satisfy constraint ...` and rolled the stack back.

If your existing stack was created with that older template (typically it is stuck in
`UPDATE_ROLLBACK_COMPLETE` and cannot be updated in place), the clean path is to
**delete the stack and redeploy fresh** so the admin user is provisioned correctly by
CloudFormation:

```bash
# 1. Tear down the old stack (DynamoDB tables are retained; see Clean up)
./deploy.sh --destroy --auto-approve

# 2. Redeploy — the custom resource now creates the Cognito admin user
./deploy.sh --auto-approve
```

Stacks created with the current template update in place normally and do **not** need
this delete-and-redeploy step.

## Managing Users

The dashboard uses a Cognito User Pool for authentication (when `EnableAuthenticatedAccess` is `true`). The initial admin user is created **by CloudFormation** from the `ADMIN_EMAIL` parameter (`config.txt`) — via a small custom resource that provisions the user idempotently — and **Cognito emails a temporary password** to that address. On first sign-in the user is prompted to set a permanent password. **Public self sign-up is disabled** — only an admin can create users. To resend an invite, add more users, or reset a password, use the AWS CLI commands below.

First, get the User Pool ID from the stack outputs:

```bash
USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name connect-analyzer-dev \
  --query "Stacks[0].Outputs[?OutputKey=='CognitoUserPoolId'].OutputValue" \
  --output text)
```

### Resend the admin invite (temporary password email)

If the invite email didn't arrive, resend it (Cognito issues a new temporary password):

```bash
aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "admin@example.com" \
  --message-action RESEND
```

### Set or reset a password

To set a password directly instead of using the emailed temporary one, or to reset any existing user's password:

```bash
# Set a permanent password (replace <PASSWORD> and the email)
aws cognito-idp admin-set-user-password \
  --user-pool-id "$USER_POOL_ID" \
  --username "admin@example.com" \
  --password "<PASSWORD>" \
  --permanent
```

Omit `--permanent` to require the user to change the password on next login.

### Create a new user

Self sign-up is disabled, so add users as an admin. Cognito emails each new user a temporary password:

```bash
aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "newuser@example.com" \
  --user-attributes Name=email,Value="newuser@example.com" Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL
```

> The password must satisfy the Cognito password policy: at least 8 characters with uppercase, lowercase, numbers, and symbols. Choose a strong value in place of `<PASSWORD>`; do not commit real credentials to source control.

## CloudFormation Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `ProjectName` | No | `connect-analyzer` | Prefix for all resource names |
| `Environment` | No | `dev` | `dev`, `staging`, or `prod` |
| `ConnectInstanceId` | Yes | — | Amazon Connect instance UUID |
| `QConnectAssistantId` | Yes | — | QConnect assistant UUID |
| `ConnectRecordingBucket` | Yes | — | Existing S3 bucket with Contact Lens output |
| `AdminEmail` | No | — | Initial admin user; Cognito emails a temporary password. Empty = skip user creation |
| `ConnectLogGroupName` | No | `AmazonConnectAgenticLogs` | CloudWatch log group for Connect agentic logs |
| `EnableAuthenticatedAccess` | No | `true` | Create Cognito User Pool for login (self sign-up disabled) |
| `CustomDomainName` | No | — | Custom domain for CloudFront |
| `AcmCertificateArn` | No | — | ACM cert ARN (us-east-1, required with custom domain) |
| `KmsKeyArn` | No | — | KMS key for DynamoDB encryption |
| `QConnectKmsKeyArn` | No | — | KMS key encrypting the QConnect assistant (auto-detected by the deploy scripts) |

> The values above are supplied from `config.txt` (Connect Instance, QConnect Assistant, Recording Bucket, ADMIN_EMAIL) by `deploy.sh`.

## Resources Created

- **DynamoDB** — `sessions` table (contactId key, GSIs on assistantId and agentName) + `agents` table
- **Lambda** — Python 3.14 function triggered by S3 events (300s timeout, 512MB)
- **S3** — Frontend hosting bucket with versioning, all public access blocked
- **CloudFront** — Distribution with OAC, HTTPS redirect, SPA error handling
- **Cognito** — User Pool + Identity Pool for authentication and credential vending
- **IAM** — Least-privilege roles for Lambda, Cognito auth/unauth, and frontend DynamoDB access

## How It Works

### Lambda Pipeline (8 steps)

1. **Sync agents** — Refreshes QConnect AI agent list into agents DynamoDB table
2. **Download** — Reads Contact Lens JSON from S3
3. **Correlate** — Queries CloudWatch Logs to find QConnect session ID for the contact
4. **Retrieve spans** — Calls QConnect ListSpans API for detailed timing data
5. **Calculate metrics** — Computes per-turn TTFT, orchestration, STT/TTS, customer wait, tokens
6. **Resolve agent** — Looks up AI agent name from the agents table
7. **Resolve voice** — Queries Connect flow logs for voice/engine config
8. **Write records** — Writes single consolidated DynamoDB record (30-day TTL)

### Latency Metric Methodology

Each turn's customer-facing silence (from when the customer stops speaking to when
they hear the agent) is decomposed into components anchored on real span and Contact
Lens timestamps. The base timestamp (from the Contact Lens filename) places transcript
offsets on the same clock as the QConnect spans.

For a turn matched to a CUSTOMER segment followed by an AGENT/SYSTEM segment, the full
silence `Customer Wait = system_start − customer_end` is decomposed as:

| Component | Definition |
|---|---|
| **Orchestration** | `inference.start − invoke_agent.start` (clamped ≥ 0) |
| **TTFT** | `inference.timeToFirstTokenMs` (from ListSpans attributes) |
| **Msg Remainder** | `TTFM − TTFT`, where `TTFM = inference.end − inference.start`. All token generation after the first token. Shown as LLM detail; overlaps early-audio streaming. |
| **Speech Processing** | `full_silence − (Orchestration + TTFT)` (clamped ≥ 0). The non-LLM portion of the customer-perceived silence — STT and TTS combined into one metric. |

`Customer Perceived Wait = Speech Processing + Orchestration + TTFT`, which
reconciles exactly to the real Contact Lens silence. **Msg Remainder is not part of
the perceived wait** — post-first-token generation overlaps the streaming of early
audio, so it is reported separately as LLM detail rather than added to the wait.

**Why STT and TTS are reported together as one metric.** True per-component TTS is
NOT measurable from ListSpans + Contact Lens. The only "agent audio started" signal
is the Contact Lens SYSTEM/AGENT segment `beginOffsetMillis`, which lags the real
(streaming) audio start by seconds and varies widely — streaming voice engines begin
audio within a few hundred milliseconds of the first token. An earlier attempt to
report TTS as a per-engine baseline produced inconsistent values (0 on some turns,
150/200/350 on others). Instead, the whole non-LLM portion of the silence — speech-to-
text, VAD, routing, and text-to-speech / audio delivery — is combined and reported as
a single metric called **Speech Processing**, derived from actual timing. It is always
available and consistent, and where the LLM time already covers the entire silence
(streaming overlap) it is simply 0.

**Segment-matching safeguards.** Each turn is matched to its transcript segment by
fuzzy text similarity (with digit-to-words and email `@`/`.` expansion for
verification-heavy flows), falling back to positional pairing. A **10-second
time-proximity guard** rejects pairings where the customer and paired agent segment
are implausibly far apart (e.g. an empty-output transfer turn that would otherwise
cross-match a distant segment and mislabel transfer/queue wait as STT/TTS). Barge-in
turns (`system_start < customer_end`) are left undecomposed.

**End-to-End Breakdown (per-turn view).** In the Interaction Analysis, each turn is
drawn as a stacked timeline with these lanes:

- **Customer Utterance** — how long the customer spoke
- **Speech Processing** — the single non-LLM speech lane (STT + TTS combined) described above
- **LLM Processing** — Orchestration + TTFT + Msg Remainder
- **Agent Response** — how long the agent's spoken response lasted

**Note on the "Exclude anomalies (> 2.5× median)" filter.** This filter uses a
threshold relative to the median of the turns currently in scope, so toggling
"Exclude disrupted turns" can move the average in a non-obvious direction. Excluding
disrupted turns raises the median, which loosens the 2.5× cutoff (fewer turns trimmed,
average can rise); including them lowers the median, tightening the cutoff (more turns
trimmed, average can fall). This is expected behavior of a median-relative filter, not
a measurement error.

### Frontend Features

- Session comparison (up to 10 side-by-side) with collapsible metric sections (collapsed by default; Expand all / Collapse all)
- Full Session IDs shown without truncation in the contacts list and comparison table
- Aggregated statistics with percentile distribution (P50, P90, P99)
- Per-turn interaction analysis with an End-to-End Breakdown timeline (Customer Utterance, Speech Processing, LLM Processing, Agent Response)
- AI agent, model, and voice/engine filters
- Date range filtering (Today, Yesterday, Last 7 Days, Custom)
- Timezone selection
- CSV export

## Manual Deployment (without deploy.sh)

```bash
# 1. Package Lambda
cd lambda-python
pip3 install --target ./package boto3==1.43.44
cd package && zip -r9 ../lambda.zip .
cd .. && zip -g lambda.zip handler.py pipeline.py && zip -gr lambda.zip steps/

# 2. Create a deployment bucket and upload
aws s3 mb s3://<YOUR-UNIQUE-DEPLOY-BUCKET>
aws s3 cp lambda.zip s3://<YOUR-UNIQUE-DEPLOY-BUCKET>/lambda.zip

# 3. Package and deploy template
aws cloudformation package \
  --template-file template.yaml \
  --s3-bucket <YOUR-UNIQUE-DEPLOY-BUCKET> \
  --output-template-file packaged.yaml

aws cloudformation deploy \
  --template-file packaged.yaml \
  --stack-name connect-analyzer-dev \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ConnectInstanceId=YOUR-UUID \
    QConnectAssistantId=YOUR-UUID \
    ConnectRecordingBucket=YOUR-BUCKET

# 4. Configure S3 notification on recording bucket (use Lambda ARN from stack outputs)
# 5. Build frontend with stack outputs in .env and upload to the frontend S3 bucket
```

## Security

- Frontend S3 bucket blocks all public access; served only via CloudFront OAC
- Lambda follows least-privilege: scoped to specific S3 prefix, specific DynamoDB tables, specific Connect instance
- Cognito Identity Pool requires authentication; unauthenticated access is disabled
- All DynamoDB tables encrypted with dedicated KMS Customer Managed Key (auto-rotation enabled)
- S3 buckets enforce server-side encryption (AES256) and TLS-only access via bucket policies
- CloudFront enforces HTTPS with TLS 1.2+ minimum protocol version
- S3 and CloudFront access logging enabled (dedicated log bucket with 90-day lifecycle)
- All npm dependencies pinned to exact versions with 7-day minimum release age
- Cognito password policy: 8+ chars, mixed case, numbers, symbols

### Data Privacy and Compliance

This tool processes and stores customer conversation data from Amazon Connect contact center interactions, including:
- Customer speech transcripts (via Contact Lens)
- PII mismatch detection results (emails, phone numbers, account numbers extracted from speech)
- LLM input/output messages from Connect Agentic agent interactions

All data is stored in DynamoDB with a 30-day TTL. Deployers are responsible for compliance with applicable data protection regulations (GDPR, HIPAA, CCPA, PCI-DSS) when handling real customer data. This includes implementing appropriate access controls, audit logging, data retention policies, and encryption. Refer to the [AWS Shared Responsibility Model](https://aws.amazon.com/compliance/shared-responsibility-model/) and [AWS Compliance Resources](https://aws.amazon.com/compliance/) for guidance.

## Clean up

`deploy.sh` tears the whole deployment down with the `--destroy` flag:

```bash
# Interactive — prompts you to type 'destroy' to confirm
./deploy.sh --destroy

# Non-interactive (skips the confirmation prompt)
./deploy.sh --destroy --auto-approve

# Target a specific stack / region / profile
./deploy.sh --destroy --stack-name my-analyzer-prod --region us-west-2 --profile my-aws-profile
```

`--destroy` performs a full cleanup, in order:

1. Empties the frontend S3 bucket, including all object versions and delete markers
2. Removes the S3 event notification from the Contact Lens recording bucket (so new
   files stop triggering the Lambda)
3. Empties and deletes the Lambda deployment bucket
4. Deletes the CloudFormation stack and waits for completion — this removes all stack
   resources, **including the DynamoDB sessions and agents tables**
5. Cleans local build artifacts (`lambda-python/package`, `lambda.zip`,
   `frontend/node_modules`, `frontend/build`, `frontend/.env`, `packaged-template.yaml`)

The recording bucket itself is never deleted — it is an existing bucket you own, not
part of this stack. Only its event notification is removed.

## Authors

**Dilin Joy** is a Senior Partner Solutions Architect at Amazon Web Services. He works
with Global System Integrators (GSIs) to implement Amazon Connect and customer
experience (CX) solutions, providing the architectural guidance that helps partners
build innovative cloud solutions and deliver real results for their clients.

**Prashanth Krishnamurthy** is a Senior Solutions Architect at Amazon Web Services in the
Worldwide Specialist Organization (Applications). He supports enterprise customers with
Amazon Connect and customer experience (CX) implementations, helping them design,
build, and optimize contact center solutions on AWS. 

**Ramprasad Srirama** is a Senior Solutions Architect at Amazon Web Services in the Worldwide
Specialist Organization (Applications). He supports enterprise customers with Amazon
Connect and customer experience (CX) implementations, bringing deep hands-on experience
to help them architect and scale their contact center solutions on AWS.

## License

This project is licensed under the MIT-0 License.
