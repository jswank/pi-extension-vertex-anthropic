# pi-extension-vertex-anthropic

Routes [Anthropic Claude](https://www.anthropic.com/claude) models hosted on
[Google Vertex AI Model Garden](https://cloud.google.com/model-garden) through
[pi](https://github.com/badlogic/pi-mono)'s built-in `anthropic-messages`
streaming logic. Authenticates with Google Application Default Credentials
(ADC).

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

## How it works

- Imports `AnthropicVertex` from `@anthropic-ai/vertex-sdk`.
- Resolves project + region from env vars (with the per-model override).
- For `us`/`eu` regions, overrides `baseURL` to the multi-region host.
- Constructs the client and forwards to pi-ai's `streamAnthropic` via the
  `client` injection point — every event, tool-use, and thinking semantic from
  the standard Anthropic provider applies, because Vertex's wire format is the
  same Messages API.

## License

MIT.
