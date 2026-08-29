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

Authenticate once:

```bash
gcloud auth application-default login
```

Then set the project and a default region:

```bash
export GOOGLE_CLOUD_PROJECT=my-gcp-project
export GOOGLE_CLOUD_LOCATION=global   # recommended; no premium, dynamic routing
```

`GOOGLE_CLOUD_LOCATION` accepts:

| Value | Routing |
| --- | --- |
| `global` | Anthropic-recommended global endpoint, no pricing premium |
| `us`, `eu` | Multi-region endpoints (10% premium) — handled via `aiplatform.{us,eu}.rep.googleapis.com` |
| `us-east5`, `europe-west4`, … | Specific regional endpoints (10% premium) |

### Per-model region overrides

If a particular model family is only available in a different region, set a
family-scoped override (checked before the default):

```bash
export GOOGLE_CLOUD_LOCATION_OPUS_MODEL=europe-west4
export GOOGLE_CLOUD_LOCATION_HAIKU_MODEL=us-east5
```

The family is derived from the Claude model id (`HAIKU`, `SONNET`, `OPUS`).

### AWS IAM Identity Center through Google WIF

The extension supports an AWS external-account ADC whose subject token type is
`urn:ietf:params:aws:token-type:aws4_request`. This is the configuration emitted
by `cloud-auth init` during the authentication work in `agent-infra`.

Google's default Node.js AWS credential supplier only reads static AWS
environment credentials or EC2 instance metadata. When the extension detects
an AWS external-account ADC, it replaces that supplier with the AWS SDK default
provider chain. The provider chain resolves `AWS_PROFILE`, reads the IAM
Identity Center token cache, and refreshes role credentials as required.

Required container inputs:

```bash
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.config/gcloud/application_default_credentials.json"
export GOOGLE_CLOUD_PROJECT=my-gcp-project
export GOOGLE_CLOUD_LOCATION=us
export AWS_PROFILE=my-sso-profile
export AWS_REGION=us-east-2
```

The corresponding files must be available in the container:

```text
~/.config/gcloud/application_default_credentials.json
~/.aws/config
~/.aws/sso/cache/
```

Mount the ADC and AWS config read-only. The SSO cache may be mounted read-write
when the AWS SDK must persist refreshed IAM Identity Center tokens. No
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, or `AWS_SESSION_TOKEN` environment
variables are required.

Non-AWS ADC types continue through the standard `AnthropicVertex` Google auth
path without modification.

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
