import {
	StringEnum,
	Type,
	type Api,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type Static,
} from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionCommandContext, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";

const PROVIDER_ID = "xai-grok";
const PROVIDER_NAME = "xAI Grok (Subscription)";
export const XAI_PROVIDER_INFO = {
	id: PROVIDER_ID,
	name: PROVIDER_NAME,
	status: "ready",
	login: "Run /login, choose Use a subscription, then choose xAI Grok.",
	manageCommand: "/xai",
} as const;
const ANSI_GREEN = "\x1b[32m";
const ANSI_GRAY = "\x1b[90m";
const ANSI_RESET = "\x1b[0m";
const API_BASE_URL = "https://api.x.ai/v1";
const AUTH_ISSUER = "https://auth.x.ai";
const DISCOVERY_URL = `${AUTH_ISSUER}/.well-known/openid-configuration`;
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPES = "openid profile email offline_access grok-cli:access api:access";
const CALLBACK_HOST = process.env.XAI_GROK_CALLBACK_HOST || "127.0.0.1";
const CALLBACK_PORT = Number(process.env.XAI_GROK_CALLBACK_PORT || 56121);
const CALLBACK_PATH = "/callback";
const LOGIN_TIMEOUT_MS = 180_000;
const REFRESH_SKEW_MS = 2 * 60 * 1000;
const X_SEARCH_MODEL_ID = "grok-4.3";
const X_SEARCH_MAX_OUTPUT_TOKENS = 1_200;
const DEFAULT_IMAGE_MODEL_ID = "grok-imagine-image-quality";
const GROK_USAGE_URL = "https://grok.com/?_s=usage";

const TEXT_IMAGE_INPUT = ["text", "image"] as ("text" | "image")[];

/**
 * Stable language models discovered from xAI's OAuth-authenticated
 * /v1/language-models endpoint on 2026-05-24 and verified with live pi smoke
 * tests. Models that list successfully but return empty/unstable chat output
 * are intentionally excluded from this initial package.
 */
const MODELS = [
	{
		id: "grok-4.3",
		name: "Grok 4.3",
		reasoning: true,
		input: TEXT_IMAGE_INPUT,
		cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 30_000,
	},
	{
		id: "grok-4.20-0309-reasoning",
		name: "Grok 4.20 Reasoning",
		reasoning: true,
		input: TEXT_IMAGE_INPUT,
		cost: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 2_000_000,
		maxTokens: 30_000,
	},
	{
		id: "grok-4.20-0309-non-reasoning",
		name: "Grok 4.20 Non-Reasoning",
		reasoning: false,
		input: TEXT_IMAGE_INPUT,
		cost: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 2_000_000,
		maxTokens: 30_000,
	},
	{
		id: "grok-build-0.1",
		name: "Grok Build 0.1",
		reasoning: false,
		input: TEXT_IMAGE_INPUT,
		cost: { input: 0.2, output: 1.5, cacheRead: 0.02, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 8_192,
	},
	{
		id: "grok-code-fast-1",
		name: "Grok Code Fast 1 (alias)",
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0.2, output: 1.5, cacheRead: 0.02, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 8_192,
	},
];

const SEARCH_X_POSTS_PARAMS = Type.Object(
	{
		query: Type.String({
			description: "What to search for on X (x.com/Twitter). Include keywords, names, or a natural-language research question.",
		}),
		max_posts: Type.Optional(Type.Integer({
			description: "Maximum number of relevant X posts to ask Grok to summarize. Default 5, max 10.",
			minimum: 1,
			maximum: 10,
			default: 5,
		})),
		from_date: Type.Optional(Type.String({
			description: "Optional start date for X search, ISO date like 2026-05-01.",
			pattern: "^\\d{4}-\\d{2}-\\d{2}$",
		})),
		to_date: Type.Optional(Type.String({
			description: "Optional end date for X search, ISO date like 2026-05-23.",
			pattern: "^\\d{4}-\\d{2}-\\d{2}$",
		})),
		allowed_x_handles: Type.Optional(Type.Array(Type.String(), {
			description: "Only consider these X handles, without or with @. Max 20. Cannot be combined with excluded_x_handles.",
			maxItems: 20,
		})),
		excluded_x_handles: Type.Optional(Type.Array(Type.String(), {
			description: "Exclude these X handles, without or with @. Max 20. Cannot be combined with allowed_x_handles.",
			maxItems: 20,
		})),
		enable_image_understanding: Type.Optional(Type.Boolean({
			description: "Whether Grok may analyze images in matching X posts. Default false.",
			default: false,
		})),
		enable_video_understanding: Type.Optional(Type.Boolean({
			description: "Whether Grok may analyze videos in matching X posts. Default false.",
			default: false,
		})),
		format: Type.Optional(StringEnum(["summary", "posts"] as const, {
			description: "summary = synthesize what people are saying; posts = list individual posts with handles/links.",
			default: "posts",
		})),
	},
	{ additionalProperties: false },
);

const GENERATE_XAI_IMAGE_PARAMS = Type.Object(
	{
		prompt: Type.String({ description: "Image prompt to send to xAI Grok Imagine." }),
		path: Type.Optional(Type.String({
			description: "Where to save the generated JPEG. Relative paths are resolved from the current working directory. Default: ./xai-image.jpg",
			default: "xai-image.jpg",
		})),
		model: Type.Optional(StringEnum(["grok-imagine-image-quality", "grok-imagine-image"] as const, {
			description: "xAI image generation model. Default: grok-imagine-image-quality.",
			default: "grok-imagine-image-quality",
		})),
		aspect_ratio: Type.Optional(StringEnum(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "auto"] as const, {
			description: "Output aspect ratio. Default: 1:1.",
			default: "1:1",
		})),
		resolution: Type.Optional(StringEnum(["1k", "2k"] as const, {
			description: "Output resolution. Default: 1k.",
			default: "1k",
		})),
	},
	{ additionalProperties: false },
);

type SearchXPostsParams = Static<typeof SEARCH_X_POSTS_PARAMS>;
type GenerateXaiImageParams = Static<typeof GENERATE_XAI_IMAGE_PARAMS>;
type Discovery = { authorizationEndpoint: string; tokenEndpoint: string };
type CallbackParams = { code?: string; state?: string; error?: string; errorDescription?: string };
type TokenPayload = {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	id_token?: string;
	token_type?: string;
};

type XaiToolName = "search_x_posts" | "generate_xai_image";
type XaiConfig = { tools: Record<XaiToolName, boolean> };
const XAI_TOOL_NAMES: XaiToolName[] = ["search_x_posts", "generate_xai_image"];
const DEFAULT_XAI_CONFIG: XaiConfig = {
	tools: {
		search_x_posts: false,
		generate_xai_image: false,
	},
};

export function registerXai(pi: ExtensionAPI) {
	pi.registerFlag("xai-tools", {
		type: "boolean",
		default: false,
		description: "Enable all pi-oauth xAI tools (search_x_posts and generate_xai_image). Default: disabled.",
	});
	pi.registerFlag("xai-x-search", {
		type: "boolean",
		default: false,
		description: "Enable only the search_x_posts tool. Default: disabled.",
	});
	pi.registerFlag("xai-image", {
		type: "boolean",
		default: false,
		description: "Enable only the generate_xai_image tool. Default: disabled.",
	});

	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: API_BASE_URL,
		api: "openai-completions" as Api,
		authHeader: true,
		models: MODELS,
		oauth: {
			name: PROVIDER_NAME,
			usesCallbackServer: true,
			login: loginWithXai,
			refreshToken: refreshXaiToken,
			getApiKey: (credentials: OAuthCredentials) => credentials.access,
		} as any,
	});

	let searchToolRegistered = false;
	let imageToolRegistered = false;

	const ensureSearchTool = () => {
		if (searchToolRegistered) return;
		searchToolRegistered = true;
		registerSearchXPostsTool(pi);
	};
	const ensureImageTool = () => {
		if (imageToolRegistered) return;
		imageToolRegistered = true;
		registerGenerateXaiImageTool(pi);
	};
	const enableTools = (tools: XaiToolName[]) => {
		if (tools.includes("search_x_posts")) ensureSearchTool();
		if (tools.includes("generate_xai_image")) ensureImageTool();
		const active = new Set(pi.getActiveTools());
		for (const tool of tools) active.add(tool);
		pi.setActiveTools([...active]);
	};
	const disableTools = (tools: XaiToolName[]) => {
		const disabled = new Set(tools);
		pi.setActiveTools(pi.getActiveTools().filter((tool) => !disabled.has(tool as XaiToolName)));
	};
	const configuredDefaultTools = (): XaiToolName[] => {
		const config = readXaiConfig();
		const enableAll = pi.getFlag("xai-tools") === true || envFlag("PI_XAI_TOOLS");
		const enableSearch = enableAll || pi.getFlag("xai-x-search") === true || envFlag("PI_XAI_X_SEARCH") || config.tools?.search_x_posts === true;
		const enableImage = enableAll || pi.getFlag("xai-image") === true || envFlag("PI_XAI_IMAGE") || config.tools?.generate_xai_image === true;
		return [
			...(enableSearch ? ["search_x_posts" as const] : []),
			...(enableImage ? ["generate_xai_image" as const] : []),
		];
	};

	pi.on("session_start", () => {
		ensureXaiConfigFile();
		const tools = configuredDefaultTools();
		if (tools.length > 0) enableTools(tools);
		else disableTools(XAI_TOOL_NAMES);
	});

	const setPersistentTools = (tools: XaiToolName[], enabled: boolean) => {
		const config = readXaiConfig();
		const toolConfig = { ...config.tools };
		for (const tool of tools) toolConfig[tool] = enabled;
		writeXaiConfig({ ...config, tools: toolConfig });
	};
	const setTools = (tools: XaiToolName[], enabled: boolean) => {
		setPersistentTools(tools, enabled);
		if (enabled) enableTools(tools);
		else disableTools(tools);
	};
	const showToolStatus = (ctx: ExtensionCommandContext) => {
		ctx.ui.notify(formatToolStatus(pi.getActiveTools()), "info");
	};
	const notifyToolStatus = (ctx: ExtensionCommandContext, beforeActiveTools?: string[]) => {
		ctx.ui.notify(
			beforeActiveTools ? formatToolTransitionStatus(beforeActiveTools, pi.getActiveTools()) : formatToolStatus(pi.getActiveTools()),
			"info",
		);
	};
	const showQuotaStatus = async (ctx: ExtensionCommandContext) => {
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
		if (!apiKey) {
			ctx.ui.notify("No xAI Grok credentials found. Run /login, choose Use a subscription, then choose xAI Grok.", "warning");
			return;
		}
		try {
			const status = await getXaiSubscriptionStatus(apiKey);
			ctx.ui.notify(status.text, "info");
		} catch (error) {
			ctx.ui.notify(`Failed to check xAI subscription status: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	};
	const showCombinedStatus = async (ctx: ExtensionCommandContext) => {
		const toolStatus = formatToolStatus(pi.getActiveTools());
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
		if (!apiKey) {
			ctx.ui.notify(`${toolStatus}\n\nQuota/account:\nNo xAI Grok credentials found. Run /login, choose Use a subscription, then choose xAI Grok.`, "warning");
			return;
		}
		try {
			const status = await getXaiSubscriptionStatus(apiKey);
			ctx.ui.notify(`${toolStatus}\n\n${status.text}`, "info");
		} catch (error) {
			ctx.ui.notify(`${toolStatus}\n\nFailed to check xAI subscription status: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	};

	pi.registerCommand("xai", {
		description: "Manage xAI Grok: status, quota, and optional tools.",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (!command) {
				const active = new Set(pi.getActiveTools());
				const choice = await ctx.ui.select("xAI Grok", [
					formatBooleanMenuRow("X search", active.has("search_x_posts")),
					formatBooleanMenuRow("Image generation", active.has("generate_xai_image")),
					formatMenuRow("Usage / quota", GROK_USAGE_URL),
				]);
				if (!choice) return;

				if (choice.startsWith("X search")) {
					const before = pi.getActiveTools();
					const enabled = !active.has("search_x_posts");
					setTools(["search_x_posts"], enabled);
					notifyToolStatus(ctx, before);
					return;
				}
				if (choice.startsWith("Image generation")) {
					const before = pi.getActiveTools();
					const enabled = !active.has("generate_xai_image");
					setTools(["generate_xai_image"], enabled);
					notifyToolStatus(ctx, before);
					return;
				}
				await showQuotaStatus(ctx);
				return;
			}

			if (command === "status" || command === "status / quota") {
				await showCombinedStatus(ctx);
				return;
			}
			if (command === "quota" || command === "account") {
				await showQuotaStatus(ctx);
				return;
			}
			if (command === "tools" || command === "tools status") {
				showToolStatus(ctx);
				return;
			}

			const parts = command.split(/\s+/);
			const action = parts[0] || "status";
			const targetText = command.replace(/^(enable|disable|on|off)\s+/, "");
			const target = targetText === command ? parts.slice(1).join(" ") || "all" : targetText;
			const tools = parseToolTarget(target);
			if (!tools || !(action === "enable" || action === "on" || action === "disable" || action === "off")) {
				ctx.ui.notify("Usage: /oauth, /xai, /xai status, /xai quota, /xai tools, /xai enable|disable search|image|all", "warning");
				return;
			}

			const before = pi.getActiveTools();
			const enabled = action === "enable" || action === "on";
			setTools(tools, enabled);
			notifyToolStatus(ctx, before);
		},
	});
}

function registerSearchXPostsTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "search_x_posts",
		label: "Search X Posts",
		description:
			"Search X (x.com/Twitter) posts using xAI Grok's server-side x_search tool. Use this for tweets/posts, X handles, and what people are saying on X; not for general web search.",
		promptSnippet: "Search X.com/Twitter posts with xAI Grok X Search and return handles, post summaries, and links/citations when available.",
		promptGuidelines: [
			"Use search_x_posts when the user asks to search X, x.com, Twitter, tweets/posts, handles, or what people are saying on X.",
			"Do not use search_x_posts for general web search unless the user specifically asks for X/Twitter content.",
		],
		parameters: SEARCH_X_POSTS_PARAMS,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: `Searching X posts for: ${params.query}` }], details: {} });
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
			if (!apiKey) throw new Error(`No xAI Grok credentials found. Run /login, choose Use a subscription, then choose xAI Grok.`);

			const result = await searchXPosts(params, apiKey, signal);
			return {
				content: [{ type: "text", text: result.text }],
				details: result.details,
			};
		},
	});
}

function registerGenerateXaiImageTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "generate_xai_image",
		label: "Generate xAI Image",
		description: "Generate one image with xAI Grok Imagine and save it as a JPEG file. Use only when the user explicitly asks to generate an image.",
		promptSnippet: "Generate an image with xAI Grok Imagine and save it to a local JPEG path.",
		promptGuidelines: [
			"Use generate_xai_image only when the user explicitly asks to create or generate an image.",
			"Always tell the user the saved image path returned by generate_xai_image.",
		],
		parameters: GENERATE_XAI_IMAGE_PARAMS,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Generating xAI image..." }], details: {} });
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
			if (!apiKey) throw new Error(`No xAI Grok credentials found. Run /login, choose Use a subscription, then choose xAI Grok.`);

			const result = await generateXaiImage(params, apiKey, ctx.cwd, signal);
			return {
				content: [{ type: "text", text: `Generated image saved to ${result.path} (${result.width}x${result.height || "unknown"}, ${result.bytes} bytes).` }],
				details: result,
			};
		},
	});
}

function formatBooleanMenuRow(label: string, value: boolean): string {
	return formatMenuRow(label, value ? "true" : "false");
}

function formatMenuRow(label: string, value: string): string {
	return `${label.padEnd(32)}${value}`;
}

function parseToolTarget(target: string): XaiToolName[] | undefined {
	const normalized = target.trim().toLowerCase().replace(/\s+/g, "-").replace(/-tool(s)?$/, "");
	if (normalized === "all" || normalized === "both" || normalized === "both-tools" || normalized === "") return XAI_TOOL_NAMES;
	if (["search", "x", "x-search", "x-search-posts", "search-x", "search-x-posts", "search_x_posts"].includes(normalized)) return ["search_x_posts"];
	if (["image", "images", "imagine", "image-generation", "generate-image", "generate_xai_image"].includes(normalized)) return ["generate_xai_image"];
	return undefined;
}

function envFlag(name: string): boolean {
	return /^(1|true|yes|on)$/i.test(process.env[name] ?? "");
}

function readXaiConfig(): XaiConfig {
	const path = xaiConfigPath();
	if (!existsSync(path)) return cloneDefaultXaiConfig();
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(parsed)) return cloneDefaultXaiConfig();
		const tools = isRecord(parsed.tools) ? parsed.tools : undefined;
		return {
			tools: {
				search_x_posts: typeof tools?.search_x_posts === "boolean" ? tools.search_x_posts : false,
				generate_xai_image: typeof tools?.generate_xai_image === "boolean" ? tools.generate_xai_image : false,
			},
		};
	} catch {
		return cloneDefaultXaiConfig();
	}
}

function ensureXaiConfigFile(): void {
	if (!existsSync(xaiConfigPath())) writeXaiConfig(DEFAULT_XAI_CONFIG);
}

function cloneDefaultXaiConfig(): XaiConfig {
	return {
		tools: { ...DEFAULT_XAI_CONFIG.tools },
	};
}

function writeXaiConfig(config: XaiConfig): void {
	const path = xaiConfigPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function xaiConfigPath(): string {
	return join(getAgentDir(), "extensions", "pi-oauth", "xai.json");
}

function formatToolStatus(activeTools: string[]): string {
	const active = new Set(activeTools);
	const labelWidth = xaiToolLabelWidth();
	return XAI_TOOL_NAMES.map((tool) => `${formatToolLabel(tool).padEnd(labelWidth)} : ${formatBoolean(active.has(tool))}`).join("\n");
}

function formatToolTransitionStatus(beforeActiveTools: string[], afterActiveTools: string[]): string {
	const before = new Set(beforeActiveTools);
	const after = new Set(afterActiveTools);
	const labelWidth = xaiToolLabelWidth();
	return XAI_TOOL_NAMES.map((tool) => {
		const beforeValue = before.has(tool);
		const afterValue = after.has(tool);
		const value = beforeValue === afterValue
			? formatBoolean(afterValue)
			: `${formatBoolean(beforeValue)} -> ${formatBoolean(afterValue)}`;
		return `${formatToolLabel(tool).padEnd(labelWidth)} : ${value}`;
	}).join("\n");
}

function xaiToolLabelWidth(): number {
	return Math.max(...XAI_TOOL_NAMES.map((tool) => formatToolLabel(tool).length));
}

function formatToolLabel(tool: XaiToolName): string {
	return tool === "search_x_posts" ? "search_x_posts (X search)" : "generate_xai_image (Image generation)";
}

function formatBoolean(value: boolean): string {
	return `${value ? ANSI_GREEN : ANSI_GRAY}${value ? "true" : "false"}${ANSI_RESET}`;
}

type XaiSubscriptionStatus = {
	text: string;
	details: {
		provider: typeof PROVIDER_ID;
		checkedAt: string;
		exactRemainingQuotaAvailable: boolean;
		accountStatus: "ok" | "blocked" | "unknown";
		usageUrl: typeof GROK_USAGE_URL;
		availableLanguageModels: string[];
		quotaLikeFields: Record<string, unknown>;
	};
};

async function getXaiSubscriptionStatus(apiKey: string): Promise<XaiSubscriptionStatus> {
	const me = await xaiGetJson("/me", apiKey);
	const languageModels = await xaiGetJson("/language-models", apiKey);
	const availableLanguageModels = extractLanguageModelIds(languageModels.json);
	const quotaLikeFields = collectQuotaLikeFields({ me: me.json, languageModels: languageModels.json });
	const teamBlocked = typeof me.json.team_blocked === "boolean" ? me.json.team_blocked : undefined;
	const accountStatus = teamBlocked === true ? "blocked" : teamBlocked === false ? "ok" : "unknown";
	const exactRemainingQuotaAvailable = Object.keys(quotaLikeFields).length > 0;
	const lines = [
		"xAI Grok account / quota:",
		`Usage: ${GROK_USAGE_URL}`,
		"Note: pi-oauth does not query Grok web subscription usage because it requires grok.com browser cookies and is not exposed by the xAI OAuth API.",
		`Account: ${accountStatus}`,
		"Available models:",
		...(availableLanguageModels.length > 0 ? availableLanguageModels.map((id) => `- ${id}`) : ["- none returned"]),
	];
	return {
		text: lines.join("\n"),
		details: {
			provider: PROVIDER_ID,
			checkedAt: new Date().toISOString(),
			exactRemainingQuotaAvailable,
			accountStatus,
			usageUrl: GROK_USAGE_URL,
			availableLanguageModels,
			quotaLikeFields,
		},
	};
}

function extractLanguageModelIds(data: Record<string, unknown>): string[] {
	const models = Array.isArray(data.models) ? data.models : [];
	return models
		.map((model) => isRecord(model) && typeof model.id === "string" ? model.id : undefined)
		.filter((id): id is string => !!id)
		.sort();
}

async function xaiGetJson(path: string, apiKey: string): Promise<{ status: number; json: Record<string, unknown> }> {
	const response = await fetch(`${API_BASE_URL}${path}`, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
		},
	});
	const text = await response.text();
	const json = parseJsonObject(text);
	if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${truncateForError(text)}`);
	return { status: response.status, json };
}

function collectQuotaLikeFields(value: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
	if (Array.isArray(value)) {
		value.slice(0, 20).forEach((item, index) => collectQuotaLikeFields(item, `${prefix}[${index}]`, out));
		return out;
	}
	if (!isRecord(value)) return out;
	for (const [key, nested] of Object.entries(value)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (/quota|remaining|usage|subscription|plan|billing|credit/i.test(key)) out[path] = nested;
		if (isRecord(nested) || Array.isArray(nested)) collectQuotaLikeFields(nested, path, out);
	}
	return out;
}

type XSearchTool = {
	type: "x_search";
	allowed_x_handles?: string[];
	excluded_x_handles?: string[];
	from_date?: string;
	to_date?: string;
	enable_image_understanding?: boolean;
	enable_video_understanding?: boolean;
};

type SearchXPostsDetails = {
	provider: typeof PROVIDER_ID;
	model: typeof X_SEARCH_MODEL_ID;
	query: string;
	format: "summary" | "posts";
	maxPosts: number;
	responseId?: string;
	outputTypes: string[];
	xSearchToolCalls: number;
	citations?: string[];
};

async function searchXPosts(params: SearchXPostsParams, apiKey: string, signal?: AbortSignal): Promise<{
	text: string;
	details: SearchXPostsDetails;
}> {
	const allowedHandles = normalizeXHandles(params.allowed_x_handles);
	const excludedHandles = normalizeXHandles(params.excluded_x_handles);
	if (allowedHandles && excludedHandles) {
		throw new Error("allowed_x_handles and excluded_x_handles cannot be used together.");
	}

	const maxPosts = clampInteger(params.max_posts ?? 5, 1, 10);
	const format = params.format ?? "posts";
	const tool: XSearchTool = { type: "x_search" };
	if (allowedHandles) tool.allowed_x_handles = allowedHandles;
	if (excludedHandles) tool.excluded_x_handles = excludedHandles;
	if (params.from_date) tool.from_date = params.from_date;
	if (params.to_date) tool.to_date = params.to_date;
	if (params.enable_image_understanding) tool.enable_image_understanding = true;
	if (params.enable_video_understanding) tool.enable_video_understanding = true;

	const requestInit: RequestInit = {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: X_SEARCH_MODEL_ID,
			input: [{ role: "user", content: buildXSearchPrompt(params.query, maxPosts, format) }],
			tools: [tool],
			max_output_tokens: X_SEARCH_MAX_OUTPUT_TOKENS,
		}),
	};
	if (signal) requestInit.signal = signal;
	const response = await fetch(`${API_BASE_URL}/responses`, requestInit);

	const bodyText = await response.text();
	const data = parseJsonObject(bodyText);
	if (!response.ok) {
		throw new Error(`xAI X search failed: HTTP ${response.status} ${truncateForError(bodyText)}`);
	}

	const outputTypes = extractOutputTypes(data);
	const citations = extractCitations(data);
	const responseText = extractResponseText(data) || "X search completed, but xAI returned no text.";
	const text = appendCitations(responseText, citations);
	const details: SearchXPostsDetails = {
		provider: PROVIDER_ID,
		model: X_SEARCH_MODEL_ID,
		query: params.query,
		format,
		maxPosts,
		outputTypes,
		xSearchToolCalls: outputTypes.filter((type) => type.includes("tool") || type === "x_search_call").length,
	};
	if (typeof data.id === "string") details.responseId = data.id;
	if (citations.length > 0) details.citations = citations;
	return { text, details };
}

function buildXSearchPrompt(query: string, maxPosts: number, format: "summary" | "posts"): string {
	const modeInstruction = format === "summary"
		? "Synthesize the main themes from the matching X posts."
		: `List up to ${maxPosts} relevant X posts.`;
	return [
		`Search X (x.com/Twitter) for: ${query}`,
		modeInstruction,
		"For each post or claim, include the X handle, date/time if available, a concise description, and a URL/citation if available.",
		"Prefer recent, high-signal posts. If there are no reliable matches, say so clearly.",
	].join("\n");
}

function normalizeXHandles(handles: string[] | undefined): string[] | undefined {
	if (!handles) return undefined;
	const normalized = [...new Set(handles
		.map((handle) => handle.trim().replace(/^@+/, ""))
		.filter((handle) => /^[A-Za-z0-9_]{1,15}$/.test(handle)))];
	return normalized.length > 0 ? normalized.slice(0, 20) : undefined;
}

function clampInteger(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

function parseJsonObject(text: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

function extractOutputTypes(data: Record<string, unknown>): string[] {
	const output = Array.isArray(data.output) ? data.output : [];
	return output
		.map((item) => isRecord(item) && typeof item.type === "string" ? item.type : undefined)
		.filter((type): type is string => !!type);
}

function extractResponseText(data: Record<string, unknown>): string {
	if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
	const output = Array.isArray(data.output) ? data.output : [];
	const chunks: string[] = [];
	for (const item of output) {
		if (!isRecord(item)) continue;
		if (typeof item.text === "string") chunks.push(item.text);
		const content = Array.isArray(item.content) ? item.content : [];
		for (const part of content) {
			if (!isRecord(part)) continue;
			if (typeof part.text === "string") chunks.push(part.text);
			else if (typeof part.content === "string") chunks.push(part.content);
		}
	}
	return chunks.join("\n").trim();
}

function extractCitations(data: Record<string, unknown>): string[] {
	const citations = Array.isArray(data.citations) ? data.citations : [];
	return citations
		.map((citation) => {
			if (typeof citation === "string") return citation;
			if (!isRecord(citation)) return undefined;
			if (typeof citation.url === "string") return citation.url;
			if (typeof citation.uri === "string") return citation.uri;
			if (typeof citation.title === "string") return citation.title;
			return undefined;
		})
		.filter((citation): citation is string => !!citation)
		.slice(0, 20);
}

function appendCitations(text: string, citations: string[]): string {
	if (citations.length === 0) return text;
	return `${text}\n\nCitations:\n${citations.map((citation, index) => `${index + 1}. ${citation}`).join("\n")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

type GenerateXaiImageDetails = {
	provider: typeof PROVIDER_ID;
	model: "grok-imagine-image-quality" | "grok-imagine-image";
	prompt: string;
	path: string;
	bytes: number;
	mediaType: "image/jpeg";
	width: number;
	height?: number;
	aspectRatio: string;
	resolution: string;
};

async function generateXaiImage(
	params: GenerateXaiImageParams,
	apiKey: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<GenerateXaiImageDetails> {
	const model = params.model ?? DEFAULT_IMAGE_MODEL_ID;
	const aspectRatio = params.aspect_ratio ?? "1:1";
	const resolution = params.resolution ?? "1k";
	const path = resolve(cwd, params.path ?? "xai-image.jpg");
	const requestInit: RequestInit = {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model,
			prompt: params.prompt,
			aspect_ratio: aspectRatio,
			resolution,
			response_format: "b64_json",
		}),
	};
	if (signal) requestInit.signal = signal;

	const response = await fetch(`${API_BASE_URL}/images/generations`, requestInit);
	const bodyText = await response.text();
	const data = parseJsonObject(bodyText);
	if (!response.ok) {
		throw new Error(`xAI image generation failed: HTTP ${response.status} ${truncateForError(bodyText)}`);
	}
	const first = Array.isArray(data.data) && isRecord(data.data[0]) ? data.data[0] : undefined;
	const b64 = typeof first?.b64_json === "string" ? first.b64_json : undefined;
	if (!b64) throw new Error("xAI image generation returned no base64 image data.");

	const bytes = Buffer.from(b64, "base64");
	await withFileMutationQueue(path, async () => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, bytes);
	});

	const size = parseJpegSize(bytes);
	const details: GenerateXaiImageDetails = {
		provider: PROVIDER_ID,
		model,
		prompt: params.prompt,
		path,
		bytes: bytes.length,
		mediaType: "image/jpeg",
		width: size?.width ?? 0,
		aspectRatio,
		resolution,
	};
	if (size?.height !== undefined) details.height = size.height;
	return details;
}

function parseJpegSize(buffer: Buffer): { width: number; height: number } | undefined {
	let offset = 2;
	while (offset < buffer.length) {
		if (buffer[offset] !== 0xff) return undefined;
		const marker = buffer[offset + 1];
		const length = buffer.readUInt16BE(offset + 2);
		if (marker && marker >= 0xc0 && marker <= 0xc3) {
			return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
		}
		offset += 2 + length;
	}
	return undefined;
}

function truncateForError(text: string, maxLength = 1_000): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact;
}

async function loginWithXai(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	callbacks.onProgress?.("Preparing xAI Grok authorization...");

	const discovery = await discoverXaiOAuth();
	const callback = await openCallbackServer();
	const pkce = createPkce();
	const state = randomUUID().replaceAll("-", "");
	const nonce = randomUUID().replaceAll("-", "");
	const authorizeUrl = buildAuthorizeUrl(discovery.authorizationEndpoint, callback.redirectUri, pkce.challenge, state, nonce);

	callbacks.onAuth({
		url: authorizeUrl,
		instructions:
			"Sign in with the xAI/Grok account for your subscription. If the browser cannot return to pi, paste the final callback URL or code into pi.",
	});

	callbacks.onManualCodeInput?.()
		.then((input) => {
			const parsed = input ? parseCallback(input) : undefined;
			if (parsed) callback.resolve(parsed);
		})
		.catch(() => undefined);

	let result: CallbackParams;
	try {
		result = await callback.wait(callbacks.signal);
	} catch {
		const manual = await callbacks.onPrompt({
			message: "Paste the xAI callback URL, query string, or authorization code:",
			placeholder: callback.redirectUri,
		});
		result = parseCallback(manual) || {};
	} finally {
		callback.close();
	}

	if (result.error) throw new Error(`xAI authorization failed: ${result.errorDescription || result.error}`);
	if (!result.code) throw new Error("xAI authorization did not return an authorization code.");
	if (result.state && result.state !== state) throw new Error("xAI authorization state mismatch.");

	callbacks.onProgress?.("Exchanging xAI authorization code...");
	const token = await requestToken(discovery.tokenEndpoint, {
		grant_type: "authorization_code",
		code: result.code,
		redirect_uri: callback.redirectUri,
		client_id: CLIENT_ID,
		code_verifier: pkce.verifier,
	});

	return credentialsFromToken(token, discovery.tokenEndpoint);
}

async function refreshXaiToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	if (!credentials.refresh) return credentials;

	const tokenEndpoint = typeof credentials.tokenEndpoint === "string" && credentials.tokenEndpoint
		? ensureXaiUrl(credentials.tokenEndpoint, "stored token endpoint")
		: (await discoverXaiOAuth()).tokenEndpoint;

	const token = await requestToken(tokenEndpoint, {
		grant_type: "refresh_token",
		refresh_token: credentials.refresh,
		client_id: CLIENT_ID,
	});

	return credentialsFromToken(token, tokenEndpoint, credentials.refresh);
}

async function discoverXaiOAuth(): Promise<Discovery> {
	const response = await fetch(DISCOVERY_URL, { headers: { Accept: "application/json" } });
	if (!response.ok) throw new Error(`xAI OAuth discovery failed: HTTP ${response.status}`);

	const data = await response.json() as Record<string, unknown>;
	return {
		authorizationEndpoint: ensureXaiUrl(data.authorization_endpoint, "authorization endpoint"),
		tokenEndpoint: ensureXaiUrl(data.token_endpoint, "token endpoint"),
	};
}

function buildAuthorizeUrl(endpoint: string, redirectUri: string, challenge: string, state: string, nonce: string): string {
	const query = new URLSearchParams({
		response_type: "code",
		client_id: CLIENT_ID,
		redirect_uri: redirectUri,
		scope: SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		nonce,
	});
	return `${endpoint}?${query}`;
}

function createPkce(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

async function openCallbackServer(): Promise<{
	redirectUri: string;
	resolve: (params: CallbackParams) => void;
	wait: (signal?: AbortSignal) => Promise<CallbackParams>;
	close: () => void;
}> {
	let finish!: (params: CallbackParams) => void;
	let settled = false;
	const received = new Promise<CallbackParams>((resolve) => {
		finish = (params) => {
			if (!settled) {
				settled = true;
				resolve(params);
			}
		};
	});

	const server = createServer((req, res) => {
		const url = new URL(req.url || "/", `http://${CALLBACK_HOST}`);
		if (url.pathname !== CALLBACK_PATH) {
			res.writeHead(404).end("Not found");
			return;
		}

		const params = paramsFromSearch(url.searchParams);
		finish(params);
		res.writeHead(params.error ? 400 : 200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(params.error ? closeTabHtml("Authorization failed") : closeTabHtml("Authorization complete"));
	});

	const activeServer = await listen(server, CALLBACK_PORT).catch(() => listen(server, 0));
	const address = activeServer.address();
	if (!address || typeof address === "string") throw new Error("Could not start xAI OAuth callback server.");

	const close = () => {
		try {
			activeServer.close();
		} catch {
			// ignore close races
		}
	};

	return {
		redirectUri: `http://${CALLBACK_HOST}:${address.port}${CALLBACK_PATH}`,
		resolve: finish,
		close,
		wait: async (signal) => {
			let timer: NodeJS.Timeout | undefined;
			let onAbort: (() => void) | undefined;
			const timeout = new Promise<CallbackParams>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Timed out waiting for xAI authorization.")), LOGIN_TIMEOUT_MS);
				onAbort = () => reject(new Error("xAI authorization cancelled."));
				signal?.addEventListener("abort", onAbort, { once: true });
			});

			try {
				return await Promise.race([received, timeout]);
			} finally {
				if (timer) clearTimeout(timer);
				if (onAbort) signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}

function listen(server: Server, port: number): Promise<Server> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, CALLBACK_HOST, () => {
			server.removeListener("error", reject);
			resolve(server);
		});
	});
}

function parseCallback(input: string): CallbackParams | undefined {
	const value = input.trim();
	if (!value) return undefined;

	try {
		const url = value.startsWith("http")
			? new URL(value)
			: new URL(`http://${CALLBACK_HOST}${CALLBACK_PATH}?${value.replace(/^\?/, "")}`);
		return paramsFromSearch(url.searchParams);
	} catch {
		return /^[A-Za-z0-9_-]{20,}$/.test(value) ? { code: value } : undefined;
	}
}

function paramsFromSearch(params: URLSearchParams): CallbackParams {
	const result: CallbackParams = {};
	const code = params.get("code");
	const state = params.get("state");
	const error = params.get("error");
	const errorDescription = params.get("error_description");
	if (code) result.code = code;
	if (state) result.state = state;
	if (error) result.error = error;
	if (errorDescription) result.errorDescription = errorDescription;
	return result;
}

async function requestToken(endpoint: string, body: Record<string, string>): Promise<TokenPayload> {
	const response = await fetch(endpoint, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(body).toString(),
	});

	if (!response.ok) throw new Error(`xAI token request failed: HTTP ${response.status} ${await response.text()}`);
	return await response.json() as TokenPayload;
}

function credentialsFromToken(token: TokenPayload, tokenEndpoint: string, previousRefresh = ""): OAuthCredentials {
	if (!token.access_token) throw new Error("xAI token response did not include an access token.");
	const refresh = token.refresh_token || previousRefresh;
	if (!refresh) throw new Error("xAI token response did not include a refresh token.");

	return {
		access: token.access_token,
		refresh,
		expires: Date.now() + (token.expires_in || 3600) * 1000 - REFRESH_SKEW_MS,
		idToken: token.id_token || "",
		tokenEndpoint,
		tokenType: token.token_type || "Bearer",
	};
}

function ensureXaiUrl(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`xAI OAuth discovery did not include ${label}.`);
	const url = new URL(value);
	const host = url.hostname.toLowerCase();
	if (url.protocol !== "https:" || (host !== "x.ai" && !host.endsWith(".x.ai"))) {
		throw new Error(`xAI OAuth returned an unexpected ${label}: ${value}`);
	}
	return value;
}

function closeTabHtml(title: string): string {
	return `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><p>You can close this tab and return to pi.</p>`;
}
