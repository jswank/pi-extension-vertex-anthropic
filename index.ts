/**
 * Vertex AI Model Garden — Anthropic Claude
 *
 * Routes Claude models hosted on Vertex AI through pi's existing
 * `anthropic-messages` streaming logic by injecting an `AnthropicVertex`
 * client. Authentication uses Google Application Default Credentials. AWS
 * external-account ADC is extended with an AWS SDK credential supplier so IAM
 * Identity Center profiles and their shared SSO cache can back Google WIF.
 *
 * Setup:
 *   gcloud auth application-default login
 *   export GOOGLE_CLOUD_PROJECT=my-project
 *   export GOOGLE_CLOUD_LOCATION=global              # default region (recommended)
 *   # Or a specific region: us-east5, europe-west4, etc.
 *   # Or a multi-region identifier: us, eu
 *   #
 *   # Optional per-model overrides (family = haiku/sonnet/opus):
 *   export GOOGLE_CLOUD_LOCATION_OPUS_MODEL=europe-west4
 *
 * Install (any of):
 *   pi install git:github.com/jswank/pi-extension-vertex-anthropic
 *   pi install npm:@jswank/pi-extension-vertex-anthropic
 *   pi install ./pi-extension-vertex-anthropic            # local path
 *
 * Pick the model:
 *   /model vertex-anthropic/claude-sonnet-4-6
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import {
	type AnthropicEffort,
	type AnthropicOptions,
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	AwsClient,
	type AwsSecurityCredentialsSupplier,
	type BaseExternalAccountClientOptions,
	type ExternalAccountSupplierContext,
} from "google-auth-library";

const PROVIDER = "vertex-anthropic";
const API: Api = "vertex-anthropic-messages" as Api;
const VERTEX_BASE_URL = "https://{location}-aiplatform.googleapis.com";

interface VertexClaudeModelDef {
	id: string;
	name: string;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	/** True for models that use adaptive thinking (type: "adaptive") rather than budget-based (type: "enabled"). */
	adaptiveThinking?: boolean;
}

// Per https://platform.claude.com/docs/en/api/claude-on-vertex-ai:
// - Newer Claude models (4.6+) have no @YYYYMMDD suffix.
// - Haiku 4.5 still requires the @date stamp.
const MODELS: VertexClaudeModelDef[] = [
	{
		id: "claude-haiku-4-5@20251001",
		name: "Claude Haiku 4.5 (Vertex)",
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6 (Vertex)",
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		adaptiveThinking: true,
	},
	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6 (Vertex)",
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		adaptiveThinking: true,
	},
	{
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7 (Vertex)",
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		adaptiveThinking: true,
	},
	{
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8 (Vertex)",
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		adaptiveThinking: true,
	},
	{
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5 (Vertex)",
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		adaptiveThinking: true,
	},
	{
		id: "claude-opus-5",
		name: "Claude Opus 5 (Vertex)",
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		adaptiveThinking: true,
	},
];

function familyKey(modelId: string): string {
	// "claude-sonnet-4-6" -> "SONNET", "claude-haiku-4-5@20251001" -> "HAIKU"
	const base = modelId.replace(/@.*$/, "").replace(/^claude-/, "");
	return base.split("-")[0]!.toUpperCase();
}

function resolveLocation(modelId: string): string {
	const family = familyKey(modelId);
	const perModel = process.env[`GOOGLE_CLOUD_LOCATION_${family}_MODEL`];
	const fallback = process.env.GOOGLE_CLOUD_LOCATION;
	const region = perModel?.trim() || fallback?.trim();
	if (!region) {
		throw new Error(
			`vertex-anthropic: no region configured for ${modelId}. ` +
				`Set GOOGLE_CLOUD_LOCATION or GOOGLE_CLOUD_LOCATION_${family}_MODEL.`,
		);
	}
	return region;
}

function resolveProject(): string {
	const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim() || process.env.GCLOUD_PROJECT?.trim();
	if (!projectId) {
		throw new Error("vertex-anthropic: set GOOGLE_CLOUD_PROJECT (or GCLOUD_PROJECT).");
	}
	return projectId;
}

interface AwsExternalAccountConfig extends BaseExternalAccountClientOptions {
	type: "external_account";
	credential_source?: {
		environment_id?: string;
	};
}

let cachedAwsAuthClient: AwsClient | undefined;
let awsAuthClientResolved = false;

function applicationDefaultCredentialsPath(): string {
	return (
		process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() ||
		join(homedir(), ".config", "gcloud", "application_default_credentials.json")
	);
}

/**
 * Build a Google AWS WIF client whose AWS credential supplier uses the full
 * AWS SDK provider chain. Google's default Node.js AWS supplier only supports
 * environment credentials and EC2 metadata; the AWS SDK chain also supports
 * AWS_PROFILE and the IAM Identity Center cache under ~/.aws/sso/cache.
 */
function resolveAwsFederatedAuthClient(): AwsClient | undefined {
	if (awsAuthClientResolved) {
		return cachedAwsAuthClient;
	}

	const adcPath = applicationDefaultCredentialsPath();
	let rawConfig: string;
	try {
		rawConfig = readFileSync(adcPath, "utf8");
	} catch (error) {
		if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
			throw new Error(`vertex-anthropic: cannot read GOOGLE_APPLICATION_CREDENTIALS at ${adcPath}`, {
				cause: error,
			});
		}
		awsAuthClientResolved = true;
		return undefined;
	}

	let adc: AwsExternalAccountConfig;
	try {
		adc = JSON.parse(rawConfig) as AwsExternalAccountConfig;
	} catch (error) {
		throw new Error(`vertex-anthropic: invalid ADC JSON at ${adcPath}`, { cause: error });
	}

	if (
		adc.type !== "external_account" ||
		adc.subject_token_type !== "urn:ietf:params:aws:token-type:aws4_request" ||
		adc.credential_source?.environment_id !== "aws1"
	) {
		awsAuthClientResolved = true;
		return undefined;
	}

	const region = process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim();
	if (!region) {
		throw new Error(
			"vertex-anthropic: AWS WIF with an SSO profile requires AWS_REGION or AWS_DEFAULT_REGION.",
		);
	}

	const profile = process.env.AWS_PROFILE?.trim();
	const credentialsProvider = fromNodeProviderChain(profile ? { profile } : {});
	const supplier: AwsSecurityCredentialsSupplier = {
		async getAwsRegion(_context: ExternalAccountSupplierContext) {
			return region;
		},
		async getAwsSecurityCredentials(_context: ExternalAccountSupplierContext) {
			const credentials = await credentialsProvider();
			return {
				accessKeyId: credentials.accessKeyId,
				secretAccessKey: credentials.secretAccessKey,
				token: credentials.sessionToken,
			};
		},
	};

	const { credential_source: _credentialSource, ...clientOptions } = adc;
	cachedAwsAuthClient = new AwsClient({
		...clientOptions,
		aws_security_credentials_supplier: supplier,
	});
	awsAuthClientResolved = true;
	return cachedAwsAuthClient;
}

// Multi-region identifiers ("us", "eu") route through dedicated endpoints
// rather than `{region}-aiplatform.googleapis.com`. The vertex-sdk doesn't
// special-case these, so we override baseURL when we see one.
function multiRegionBaseURL(region: string): string | undefined {
	switch (region) {
		case "us":
			return "https://aiplatform.us.rep.googleapis.com/v1";
		case "eu":
			return "https://aiplatform.eu.rep.googleapis.com/v1";
		default:
			return undefined;
	}
}

// Adaptive thinking is supported on Sonnet and Opus models; Haiku uses
// budget-based thinking. (Mirrors `supportsAdaptiveThinking` in pi-ai.)
function supportsAdaptiveThinking(modelId: string): boolean {
	return /sonnet|opus/.test(modelId);
}

function mapReasoningToEffort(reasoning: SimpleStreamOptions["reasoning"]): AnthropicEffort {
	switch (reasoning) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		default:
			return "high";
	}
}

const THINKING_BUDGETS: Partial<Record<NonNullable<SimpleStreamOptions["reasoning"]>, number>> = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
};

function buildAnthropicOptions(model: Model<Api>, options?: SimpleStreamOptions): AnthropicOptions {
	const base: AnthropicOptions = {
		temperature: options?.temperature,
		maxTokens: options?.maxTokens ?? (model.maxTokens > 0 ? Math.min(model.maxTokens, 32000) : undefined),
		signal: options?.signal,
		transport: options?.transport,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		headers: options?.headers,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		timeoutMs: options?.timeoutMs,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
	};

	if (!options?.reasoning) {
		return { ...base, thinkingEnabled: false };
	}

	if (supportsAdaptiveThinking(model.id)) {
		return { ...base, thinkingEnabled: true, effort: mapReasoningToEffort(options.reasoning) };
	}

	const level = options.reasoning === "max" || options.reasoning === "xhigh" ? "high" : options.reasoning;
	const thinkingBudget = options.thinkingBudgets?.[level] ?? THINKING_BUDGETS[level] ?? THINKING_BUDGETS.high!;
	const baseMax = base.maxTokens ?? 0;
	const maxTokens = Math.min(baseMax + thinkingBudget, model.maxTokens);
	return {
		...base,
		maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: maxTokens <= thinkingBudget ? Math.max(0, maxTokens - 1024) : thinkingBudget,
	};
}

function streamVertexAnthropic(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const projectId = resolveProject();
	const region = resolveLocation(model.id);
	const baseURL = multiRegionBaseURL(region);
	const authClient = resolveAwsFederatedAuthClient();

	// AnthropicVertex mints a bearer token through google-auth-library. Standard
	// ADC remains the default. For an AWS external-account ADC, the custom client
	// resolves AWS_PROFILE through the AWS SDK, including IAM Identity Center SSO.
	const client = new AnthropicVertex({
		projectId,
		region,
		...(baseURL && { baseURL }),
		...(authClient && { authClient }),
	});

	// Reuse pi-ai's full Anthropic streaming path — events, tool use, thinking,
	// prompt caching all carry over because the wire format is identical.
	const anthropicOptions = buildAnthropicOptions(model, options);
	return streamAnthropic(model as Model<"anthropic-messages">, context, {
		...anthropicOptions,
		// AnthropicVertex and Anthropic both extend BaseAnthropic and expose the
		// same `messages.create` surface; the cast bridges nominal `#private`
		// fields between SDK installs.
		client: client as unknown as AnthropicOptions["client"],
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER, {
		api: API,
		baseUrl: VERTEX_BASE_URL,
		// ADC handles real auth inside AnthropicVertex; the harness only needs a
		// non-empty literal marker so it doesn't treat the provider as unconfigured.
		// Must not be all-caps (which pi detects as a legacy env-var reference).
		apiKey: "gcp-adc",
		models: MODELS.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: true,
			input: ["text", "image"],
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			...(m.adaptiveThinking && { compat: { forceAdaptiveThinking: true } }),
		})),
		streamSimple: streamVertexAnthropic,
	});
}
