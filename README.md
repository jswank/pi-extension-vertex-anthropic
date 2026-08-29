# pi-extension-vertex-anthropic

Routes [Anthropic Claude](https://www.anthropic.com/claude) models hosted on
[Google Vertex AI Model Garden](https://cloud.google.com/model-garden) through
[pi](https://github.com/badlogic/pi-mono)'s built-in `anthropic-messages`
streaming logic. Authentication uses Google Application Default Credentials
(ADC), including AWS Workload Identity Federation (WIF) backed by an AWS IAM
Identity Center profile.

## Install

```bash
# from a git repo
pi install git:github.com/jswank/pi-extension-vertex-anthropic

# or from npm (once published)
pi install npm:@jswank/pi-extension-vertex-anthropic

# or from a local checkout
pi install ./pi-extension-vertex-anthropic
```

Add `-l` to install only into the current project (`./.pi/settings.json`)
instead of user-global (`~/.pi/settings.json`).

## Configure

Set the Google Cloud project and a default Vertex location for either
authentication mode:

```bash
export GOOGLE_CLOUD_PROJECT=my-gcp-project
export GOOGLE_CLOUD_LOCATION=global
```

Then configure one of the following Application Default Credentials (ADC)
modes.

### Mode 1: Google user ADC

For local development with a Google user identity, create the standard ADC:

```bash
gcloud auth application-default login
```

The extension delegates non-AWS credentials to the standard `AnthropicVertex`
Google authentication path.

### Mode 2: AWS IAM Identity Center through Google WIF

For AWS-backed Google Workload Identity Federation (WIF), initialize the static
AWS configuration and Google external-account ADC, then authenticate with IAM
Identity Center:

```bash
cloud-auth init
cloud-auth login
```

`cloud-auth init` generates an ADC containing Google's versioned AWS environment
identifier, `aws1`. Users do not set `aws1` manually. At runtime, configure:

```bash
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.config/gcloud/application_default_credentials.json"
export GOOGLE_CLOUD_PROJECT=my-gcp-project
export GOOGLE_CLOUD_LOCATION=us
export AWS_PROFILE=my-sso-profile
export AWS_REGION=us-east-2
```

The runtime must have these files:

```text
~/.config/gcloud/application_default_credentials.json
~/.aws/config
~/.aws/sso/cache/
```

The ADC and AWS config can be mounted read-only. Mount the SSO cache read-write
when the AWS SDK must persist refreshed IAM Identity Center tokens. No
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, or `AWS_SESSION_TOKEN` environment
variables are required.

The minimum relevant ADC structure is:

```json
{
  "type": "external_account",
  "audience": "//iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/providers/PROVIDER_ID",
  "subject_token_type": "urn:ietf:params:aws:token-type:aws4_request",
  "token_url": "https://sts.googleapis.com/v1/token",
  "credential_source": {
    "environment_id": "aws1",
    "regional_cred_verification_url": "https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15"
  },
  "service_account_impersonation_url": "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/SERVICE_ACCOUNT:generateAccessToken"
}
```

The extension activates its AWS profile integration only when all three markers
match:

- `type` is `external_account`.
- `subject_token_type` is `urn:ietf:params:aws:token-type:aws4_request`.
- `credential_source.environment_id` is `aws1`.

`aws1` is Google's current AWS credential-source protocol version. It is not an
AWS profile, account, role, or IAM Identity Center session name. An unknown
future version such as `aws2` is intentionally not intercepted by the extension.

Google's default Node.js AWS credential supplier reads static AWS environment
credentials or EC2 instance metadata. For the matching ADC, the extension uses
an `AwsSecurityCredentialsSupplier` backed by the AWS SDK default provider
chain. That chain resolves `AWS_PROFILE`, reads the IAM Identity Center cache,
and refreshes AWS role credentials as required.

The `pi-dev` flow is:

```text
cloud-auth init
    └── generates AWS config and an ADC containing environment_id: aws1

cloud-auth login
    └── populates the IAM Identity Center cache

pi-dev
    ├── mounts the ADC under ~/.config/gcloud
    ├── mounts AWS config and SSO cache under ~/.aws
    ├── sets AWS_PROFILE and AWS_REGION
    └── starts Pi

pi-extension-vertex-anthropic
    ├── detects external_account + aws4_request + aws1
    ├── resolves AWS_PROFILE through the AWS SDK provider chain
    ├── signs AWS GetCallerIdentity for Google STS
    └── impersonates the service account configured in the ADC
```

### Vertex location

`GOOGLE_CLOUD_LOCATION` accepts:

| Value | Routing |
| --- | --- |
| `global` | Anthropic-recommended global endpoint, no pricing premium |
| `us`, `eu` | Multi-region endpoints (10% premium) — handled via `aiplatform.{us,eu}.rep.googleapis.com` |
| `us-east5`, `europe-west4`, … | Specific regional endpoints (10% premium) |

If a model family is only available in another region, set a family-scoped
override. The override takes precedence over `GOOGLE_CLOUD_LOCATION`:

```bash
export GOOGLE_CLOUD_LOCATION_OPUS_MODEL=europe-west4
export GOOGLE_CLOUD_LOCATION_HAIKU_MODEL=us-east5
```

The family is derived from the Claude model ID (`HAIKU`, `SONNET`, or `OPUS`).

## Use

```bash
pi
> /model vertex-anthropic/claude-sonnet-4-6
```

Models registered:

| Provider/model id | Notes |
| --- | --- |
| `vertex-anthropic/claude-haiku-4-5@20251001` | 200k ctx, budget-based thinking |
| `vertex-anthropic/claude-sonnet-4-6` | 1M ctx, adaptive thinking |
| `vertex-anthropic/claude-opus-4-6` | 1M ctx, adaptive thinking |
| `vertex-anthropic/claude-opus-4-7` | 1M ctx, adaptive thinking |
| `vertex-anthropic/claude-opus-4-8` | 1M ctx, adaptive thinking |
| `vertex-anthropic/claude-sonnet-5` | 1M ctx, adaptive thinking |
| `vertex-anthropic/claude-opus-5` | 1M ctx, adaptive thinking |

Pricing in `index.ts` matches Anthropic-direct pricing — Vertex regional and
multi-region endpoints add a 10% premium that is not reflected in the cost
field.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `404 ... locations/<region>` | Model not enabled in that region, or `@<version>` suffix wrong. Check the [Vertex AI Model Garden](https://cloud.google.com/model-garden). |
| `403 PERMISSION_DENIED` | Caller missing `aiplatform.endpoints.predict`. Bind `roles/aiplatform.user` on the project. |
| `No region was given` | `GOOGLE_CLOUD_LOCATION` (or family-specific override) is unset. |
| `set GOOGLE_CLOUD_PROJECT` | Project env var missing. |
| `Unable to determine AWS region` or extension region error | Set `AWS_REGION` or `AWS_DEFAULT_REGION` for AWS WIF. |
| AWS SSO token or profile error | Confirm `AWS_PROFILE`, `~/.aws/config`, and `~/.aws/sso/cache/` are available to the Pi process. |

## How it works

- Imports `AnthropicVertex` from `@anthropic-ai/vertex-sdk`.
- Resolves project + region from env vars (with the per-model override).
- For `us`/`eu` regions, overrides `baseURL` to the multi-region host.
- Detects AWS external-account ADC and constructs a Google `AwsClient` with an
  AWS SDK credential supplier, adding IAM Identity Center profile support.
- For all other ADC types, uses the Vertex SDK's standard Google authentication.
- Constructs the client and forwards to pi-ai's Anthropic stream implementation
  via the `client` injection point — every event, tool-use, and thinking semantic
  from the standard Anthropic provider applies because Vertex's wire format is
  the same Messages API.

## License

MIT.
