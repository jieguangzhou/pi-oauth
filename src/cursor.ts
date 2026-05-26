import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { AgentMode, AgentServiceClient } from "./cursor-agent/agent-service.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROVIDER_ID = "cursor";
const PROVIDER_NAME = "Cursor";
const DEFAULT_MODEL = process.env.CURSOR_DEFAULT_MODEL || "composer-2.5";
const CURSOR_API = "cursor-direct" as Api;
const CURSOR_API_URL = process.env.CURSOR_API_URL || "https://api2.cursor.sh";
const CURSOR_CLIENT_VERSION = process.env.CURSOR_CLIENT_VERSION || detectCursorClientVersion() || "3.5.33";
const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = `${CURSOR_API_URL}/auth/poll`;
const CURSOR_REFRESH_URL = process.env.CURSOR_REFRESH_URL || `${CURSOR_API_URL}/auth/exchange_user_api_key`;
const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY_MS = 1_000;
const POLL_MAX_DELAY_MS = 10_000;
const POLL_BACKOFF_MULTIPLIER = 1.2;
const FALLBACK_EXPIRY_MS = 60 * 60 * 1000;
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export const CURSOR_PROVIDER_INFO = {
	id: PROVIDER_ID,
	name: PROVIDER_NAME,
	status: "ready",
	login: "Run /login, choose Cursor, and authorize the subscription in your browser.",
	manageCommand: "/cursor",
} as const;

type CursorCredentialModel = {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
};
type CursorCredentials = OAuthCredentials & {
	cursorModels?: CursorCredentialModel[];
	cursorModelDiscoveryAt?: number;
};
type CursorConversationState = {
	tokenHash: string;
	modelId: string;
	conversationId: string;
	prefixSignature: string;
	client: AgentServiceClient;
	checkpoint?: Uint8Array;
	lastUsedAt: number;
};
type CursorUsage = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
type CursorApiStreamEvent =
	| { type: "text"; content: string }
	| { type: "usage"; usage: CursorUsage }
	| { type: "tool_call"; id: string; name: string; arguments: Record<string, any>; execRequest?: any };
type CursorActiveRun = {
	key?: string;
	state: CursorConversationState;
	queue: AsyncEventQueue<CursorApiStreamEvent>;
	tools?: Context["tools"];
	requestMeta?: CursorRequestMetadata;
	pendingExecRequest?: any;
	lastUsedAt: number;
};
type CursorRequestMetadata = {
	modelDisplayName?: string;
	/** Cursor RequestContext rule content generated from pi's system prompt. */
	systemPrompt?: string;
	requestedModel?: { modelId: string; maxMode?: boolean; parameters?: Array<{ id: string; value: string }> };
};
const STREAM_DONE = Symbol("cursor-stream-done");
type ToolCallPlan =
	| { action: "final"; content: string }
	| { action: "tool_call"; tool_calls: Array<{ name: string; arguments?: unknown }> };

const CURSOR_CONVERSATION_CACHE_MAX = 20;
const cursorConversationStates = new Map<string, CursorConversationState>();
const cursorActiveRuns = new Map<string, CursorActiveRun>();

class AsyncEventQueue<T> implements AsyncIterable<T> {
	private values: T[] = [];
	private waiters: Array<{ resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void }> = [];
	private ended = false;
	private error: unknown;

	push(value: T): void {
		if (this.ended) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter.resolve({ value, done: false });
		else this.values.push(value);
	}

	end(): void {
		if (this.ended) return;
		this.ended = true;
		for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
	}

	fail(error: unknown): void {
		if (this.ended) return;
		this.error = error;
		this.ended = true;
		for (const waiter of this.waiters.splice(0)) waiter.reject(error);
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.values.length > 0) {
				yield this.values.shift() as T;
				continue;
			}
			if (this.error) throw this.error;
			if (this.ended) return;
			const result = await new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }));
			if (result.done) return;
			yield result.value;
		}
	}
}

const MODELS = [
	model("auto", "Cursor Auto", true, 200_000, 64_000),
	model("composer-2.5", "Composer 2.5", true, 200_000, 64_000, { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0 }),
	model("composer-2.5-fast", "Composer 2.5 Fast", true, 200_000, 64_000, { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0 }),
	model("claude-4.6-sonnet", "Claude 4.6 Sonnet", true, 200_000, 64_000, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }),
	model("claude-4.7-opus", "Claude 4.7 Opus", true, 200_000, 128_000, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }),
	model("gpt-5.3-codex", "GPT-5.3 Codex", true, 272_000, 128_000, { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 }),
	model("gpt-5.5", "GPT-5.5", true, 272_000, 128_000, { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 }),
	model("gemini-3.1-pro", "Gemini 3.1 Pro", true, 200_000, 64_000, { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 }),
	model("gemini-3.5-flash", "Gemini 3.5 Flash", true, 200_000, 64_000, { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 }),
	model("grok-4.3", "Grok 4.3", true, 200_000, 64_000, { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 }),
];

export function registerCursor(pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER_ID, createCursorProviderConfig());

	pi.registerCommand("cursor", {
		description: "Manage Cursor subscription OAuth status.",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (!command || command === "status") {
				await showCursorStatus(ctx);
				return;
			}
			if (["refresh", "refresh-models", "models"].includes(command)) {
				await refreshCursorModels(pi, ctx);
				return;
			}
			ctx.ui.notify("Usage: /cursor, /cursor status, /cursor refresh-models. Use /login to add Cursor subscription credentials.", "warning");
		},
	});
}

function createCursorProviderConfig(models = MODELS): ProviderConfig {
	return {
		name: PROVIDER_NAME,
		baseUrl: CURSOR_API_URL,
		api: CURSOR_API,
		authHeader: true,
		models,
		streamSimple: streamCursorDirect,
		oauth: {
			name: PROVIDER_NAME,
			login: loginWithCursorOAuth,
			refreshToken: refreshCursorOAuthToken,
			getApiKey: (credentials: OAuthCredentials) => credentials.access,
			modifyModels: (models: Model<Api>[], credentials: OAuthCredentials) => {
				const discovered = modelsFromCredentials(credentials);
				if (discovered.length === 0) return models;
				return mergeCursorProviderModels(models, discovered);
			},
		} as any,
	};
}

function model(id: string, name: string, reasoning: boolean, contextWindow: number, maxTokens: number, cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) {
	return { id, name, reasoning, input: ["text"] as ("text" | "image")[], cost, contextWindow, maxTokens, api: CURSOR_API };
}

function providerModelsFromCursorModels(models: CursorCredentialModel[]): Model<Api>[] {
	return models.map((entry) => ({
		...model(entry.id, entry.name, cursorModelSupportsThinking(entry.id, entry.name, entry.reasoning), entry.contextWindow, entry.maxTokens),
		provider: PROVIDER_ID,
		baseUrl: CURSOR_API_URL,
	} as Model<Api>));
}

function mergeCursorProviderModels(models: Model<Api>[], discovered: Model<Api>[]): Model<Api>[] {
	const otherProviderModels = models.filter((entry) => entry.provider !== PROVIDER_ID);
	// Keep the configured Cursor model list (package defaults plus any
	// ~/.pi/agent/models.json overrides) as the base list so manually configured
	// entries such as cursor/auto and cursor/composer-2.5 are not removed when the
	// authenticated subscription discovery response omits them.
	const configuredCursorModels = models.filter((entry) => entry.provider === PROVIDER_ID);
	return [...otherProviderModels, ...mergeModelLists(configuredCursorModels, discovered)];
}

function mergeModelLists<T extends { id: string }>(base: T[], additions: T[]): T[] {
	const seen = new Set<string>();
	const merged: T[] = [];
	for (const entry of [...base, ...additions]) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		merged.push(entry);
	}
	return merged;
}

function cursorModelSupportsThinking(id: string, name = id, apiFlag = false): boolean {
	if (apiFlag) return true;
	const normalized = `${id} ${name}`.toLowerCase();
	// Cursor AgentService often omits ModelDetails.thinking_details even for
	// models that Cursor's UI/CLI can run with an internal reasoning budget.
	// Keep pi's Thinking Level picker enabled for Cursor subscription models;
	// individual effort/max-mode routing is handled by Cursor's backend/model slug.
	if (normalized.includes("non-reasoning")) return false;
	return true;
}

function modelsFromCredentials(credentials: OAuthCredentials): Model<Api>[] {
	const cursorCredentials = credentials as CursorCredentials;
	if (!Array.isArray(cursorCredentials.cursorModels)) return [];
	return providerModelsFromCursorModels(cursorCredentials.cursorModels.filter(isCursorCredentialModel));
}

function isCursorCredentialModel(value: unknown): value is CursorCredentialModel {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return typeof record.id === "string" && typeof record.name === "string" && typeof record.reasoning === "boolean" && typeof record.contextWindow === "number" && typeof record.maxTokens === "number";
}

async function withDiscoveredCursorModels(credentials: CursorCredentials, onProgress?: (message: string) => void): Promise<CursorCredentials> {
	try {
		const models = await discoverCursorModels(credentials.access);
		if (models.length > 0) {
			credentials.cursorModels = credentialModelsFromProviderModels(models);
			credentials.cursorModelDiscoveryAt = Date.now();
			onProgress?.(`Discovered ${models.length} Cursor model${models.length === 1 ? "" : "s"}.`);
		}
	} catch (error) {
		onProgress?.(`Cursor model discovery failed; using fallback models. ${error instanceof Error ? error.message : String(error)}`);
	}
	return credentials;
}

function credentialModelsFromProviderModels(models: Model<Api>[]): CursorCredentialModel[] {
	return models.map((entry) => ({
		id: entry.id,
		name: entry.name,
		reasoning: cursorModelSupportsThinking(entry.id, entry.name, entry.reasoning),
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
	}));
}

async function discoverCursorModels(accessToken: string): Promise<Model<Api>[]> {
	const client = new AgentServiceClient(accessToken, {
		workspacePath: process.cwd(),
		privacyMode: true,
		baseUrl: CURSOR_API_URL,
	});
	const usableModels = await client.getUsableModels();
	return providerModelsFromCursorModels(usableModels);
}

async function loginWithCursorOAuth(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	callbacks.onProgress?.("Preparing Cursor browser authorization...");
	const pkce = createPkce();
	const uuid = randomUUID();
	const loginUrl = buildCursorLoginUrl(pkce.challenge, uuid);

	callbacks.onAuth({
		url: loginUrl,
		instructions: "Authorize Cursor in your browser. pi will poll Cursor until the login is approved, then discover the Cursor models available to this subscription.",
	});

	callbacks.onProgress?.("Waiting for Cursor authorization...");
	const token = await pollCursorAuth(uuid, pkce.verifier, callbacks.signal);
	const credentials = cursorCredentialsFromToken(token.accessToken, token.refreshToken) as CursorCredentials;
	callbacks.onProgress?.("Discovering Cursor subscription models...");
	return withDiscoveredCursorModels(credentials, callbacks.onProgress);
}

async function refreshCursorOAuthToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	if (!credentials.refresh || !looksLikeJwt(credentials.access)) return credentials;
	if (credentials.expires && credentials.expires > Date.now() + REFRESH_SKEW_MS) return credentials;

	const response = await fetch(CURSOR_REFRESH_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${credentials.refresh}`,
			"Content-Type": "application/json",
		},
		body: "{}",
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Cursor token refresh failed: HTTP ${response.status}${body ? ` ${body}` : ""}`);
	}

	const data = await response.json() as { accessToken?: string; refreshToken?: string };
	if (!data.accessToken) throw new Error("Cursor token refresh did not return an access token.");
	const refresh = looksLikeJwt(data.refreshToken) ? data.refreshToken : credentials.refresh;
	return withDiscoveredCursorModels(cursorCredentialsFromToken(data.accessToken, refresh) as CursorCredentials);
}

function streamCursorDirect(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		const output = createOutput(model);
		const abortImmediately = () => {
			output.stopReason = "aborted";
			output.errorMessage = "Cursor request aborted.";
			stream.push({ type: "error", reason: "aborted", error: output });
		};
		options?.signal?.addEventListener("abort", abortImmediately, { once: true });
		try {
			if (options?.signal?.aborted) {
				abortImmediately();
				return;
			}
			const apiKey = options?.apiKey;
			if (!apiKey) throw new Error("No Cursor OAuth token found. Run /login and choose Cursor.");

			stream.push({ type: "start", partial: output });
			const modelId = normalizeCursorModel(model.id);
			const useJsonToolEmulation = process.env.PI_CURSOR_JSON_TOOLS === "1" && Boolean(context.tools?.length);
			const useActiveTools = process.env.PI_CURSOR_ACTIVE_TOOLS !== "0";
			const activeRun = useJsonToolEmulation || !useActiveTools ? undefined : getCursorActiveRun(apiKey, modelId, context);
			if (activeRun) {
				try {
					await resumeCursorActiveRun(activeRun, context.messages.at(-1));
					const stopReason = await consumeCursorActiveRun(activeRun, stream, output, context, options);
					stream.push({ type: "done", reason: stopReason, message: output });
					stream.end();
					return;
				} catch (error) {
					if (options?.signal?.aborted) throw error;
					if (activeRun.key) cursorActiveRuns.delete(activeRun.key);
					// Fall back to reliable pi-context replay if an active bridge cannot be resumed.
				}
			}

			const useConversationCache = process.env.PI_CURSOR_CONVERSATION_CACHE !== "0" && !useJsonToolEmulation;
			const conversation = useConversationCache ? getCursorConversation(apiKey, modelId, context) : undefined;
			const requestMeta = cursorRequestMetadata(model, context, options);
			const prompt = useJsonToolEmulation ? buildToolCallingPrompt(context) : conversation?.prompt ?? buildCursorPrompt(context);

			if (useJsonToolEmulation) {
				const text = await collectCursorApiText(apiKey, prompt, modelId, options?.signal, requestMeta);
				const plan = parseToolCallPlan(text.trim());
				if (plan?.action === "tool_call") {
					emitToolCalls(stream, output, plan.tool_calls);
					stream.push({ type: "done", reason: "toolUse", message: output });
					stream.end();
					return;
				}
				emitText(stream, output, plan?.action === "final" ? plan.content : text.trim());
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();
				return;
			}

			let contentIndex: number | undefined;
			let assistantText = "";
			let usedConversationFallback = false;
			const consumeEvents = async (eventPrompt: string, eventConversation?: CursorConversationState, eventMeta = requestMeta): Promise<"stop" | "toolUse"> => {
				if (useActiveTools && eventConversation && context.tools?.length) {
					const run = startCursorActiveRun(eventConversation, eventPrompt, modelId, context.tools, eventMeta);
					return consumeCursorActiveRun(run, stream, output, context, options);
				}
				for await (const chunk of streamCursorApiEvents(apiKey, eventPrompt, modelId, options?.signal, eventConversation, context.tools, eventMeta)) {
					if (chunk.type === "text") {
						if (!chunk.content) continue;
						assistantText += chunk.content;
						contentIndex = appendTextDelta(stream, output, chunk.content, contentIndex);
						continue;
					}
					if (chunk.type === "usage") {
						applyCursorUsage(output, chunk.usage);
						continue;
					}

					finishText(stream, output, contentIndex);
					emitToolCall(stream, output, chunk);
					if (eventConversation && !usedConversationFallback) rememberCursorToolConversation(eventConversation, context, assistantText, chunk);
					return "toolUse";
				}
				return "stop";
			};

			let stopReason: "stop" | "toolUse";
			try {
				stopReason = await consumeEvents(prompt, conversation?.state);
			} catch (error) {
				// If Cursor already streamed visible assistant text, do not replay the
				// prompt on a late stream/transport error: that appends a second answer to
				// the same pi turn. Treat the already-streamed answer as complete instead.
				if (assistantText || contentIndex !== undefined || hasVisibleAssistantOutput(output)) {
					stopReason = "stop";
				} else {
					if (!conversation?.state.checkpoint || options?.signal?.aborted) throw error;
					usedConversationFallback = true;
					stopReason = await consumeEvents(buildCursorPrompt(context), undefined);
				}
			}
			if (stopReason === "stop" && !hasVisibleAssistantOutput(output) && conversation?.state.checkpoint && !usedConversationFallback && !options?.signal?.aborted) {
				usedConversationFallback = true;
				stopReason = await consumeEvents(buildCursorPrompt(context), undefined);
			}
			if (stopReason === "toolUse") {
				stream.push({ type: "done", reason: "toolUse", message: output });
				stream.end();
				return;
			}
			finishText(stream, output, contentIndex);
			if (conversation && assistantText && !usedConversationFallback) rememberCursorConversation(conversation.state, context, assistantText);
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		} finally {
			options?.signal?.removeEventListener("abort", abortImmediately);
		}
	})();
	return stream;
}

function createOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function hasVisibleAssistantOutput(output: AssistantMessage): boolean {
	return output.content.some((block: any) => {
		if (block?.type === "text") return Boolean(block.text);
		return block?.type === "toolCall";
	});
}

function applyCursorUsage(output: AssistantMessage, usage: CursorUsage): void {
	const input = usage.inputTokens ?? output.usage.input;
	const out = usage.outputTokens ?? output.usage.output;
	const cacheRead = usage.cacheReadTokens ?? output.usage.cacheRead;
	const cacheWrite = usage.cacheWriteTokens ?? output.usage.cacheWrite;
	output.usage.input = input;
	output.usage.output = out;
	output.usage.cacheRead = cacheRead;
	output.usage.cacheWrite = cacheWrite;
	output.usage.totalTokens = input + out;
}

async function showCursorStatus(ctx: ExtensionCommandContext): Promise<void> {
	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
	const stored = ctx.modelRegistry.authStorage.get(PROVIDER_ID) as (CursorCredentials & { type?: string }) | undefined;
	const discoveredCount = Array.isArray(stored?.cursorModels) ? stored.cursorModels.filter(isCursorCredentialModel).length : 0;
	const discoveredAt = typeof stored?.cursorModelDiscoveryAt === "number" ? new Date(stored.cursorModelDiscoveryAt).toLocaleString() : undefined;
	ctx.ui.notify([
		"Cursor subscription provider",
		`Provider: ${PROVIDER_ID} (${PROVIDER_NAME})`,
		`Mode: browser OAuth → native Cursor AgentService (${CURSOR_API_URL})`,
		`Auth: ${apiKey ? "OAuth credentials found" : "not logged in"}`,
		`Models: ${discoveredCount > 0 ? `${discoveredCount} subscription model${discoveredCount === 1 ? "" : "s"}${discoveredAt ? ` discovered ${discoveredAt}` : ""}` : "fallback list until login/model refresh"}`,
		"",
		"Setup:",
		"1. /login → Cursor",
		"2. Authorize in the browser popup",
		"3. Optional: /cursor refresh-models after login to refresh the live subscription model list",
	].join("\n"), apiKey ? "info" : "warning");
}

async function refreshCursorModels(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
	if (!apiKey) {
		ctx.ui.notify("No Cursor OAuth credentials found. Run /login → Cursor first.", "warning");
		return;
	}
	ctx.ui.notify("Refreshing Cursor subscription models...", "info");
	let models: Model<Api>[];
	try {
		models = await discoverCursorModels(apiKey);
	} catch (error) {
		ctx.ui.notify(`Cursor model discovery failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	if (models.length === 0) {
		ctx.ui.notify("Cursor model discovery returned no models; keeping the fallback model list.", "warning");
		return;
	}

	const stored = ctx.modelRegistry.authStorage.get(PROVIDER_ID) as (CursorCredentials & { type?: string }) | undefined;
	if (stored?.type === "oauth") {
		ctx.modelRegistry.authStorage.set(PROVIDER_ID, {
			...stored,
			cursorModels: credentialModelsFromProviderModels(models),
			cursorModelDiscoveryAt: Date.now(),
		} as any);
		ctx.modelRegistry.refresh();
	} else {
		pi.registerProvider(PROVIDER_ID, createCursorProviderConfig(mergeModelLists(MODELS, models)));
	}

	ctx.ui.notify(`Cursor model list refreshed with ${models.length} model${models.length === 1 ? "" : "s"}.`, "info");
}

function buildCursorPrompt(context: Context): string {
	const onlyMessage = context.messages.length === 1 ? context.messages[0] : undefined;
	if (onlyMessage?.role === "user") return messageContentToText(onlyMessage.content);

	const lines: string[] = [];
	for (const message of context.messages) {
		if (message.role === "user") lines.push(`USER: ${messageContentToText(message.content)}`);
		else if (message.role === "assistant") lines.push(`ASSISTANT: ${message.content.map(blockToText).filter(Boolean).join("\n")}`);
		else lines.push(`TOOL RESULT (${message.toolName}${message.isError ? ", error" : ""}): ${message.content.map(blockToText).filter(Boolean).join("\n")}`);
	}
	if (context.messages.at(-1)?.role === "toolResult") {
		lines.push("INSTRUCTION: The latest tool result is available above. Use it to answer the user's original request now; do not call another tool unless the result is missing or unusable.");
	}
	return lines.join("\n\n");
}

function getCursorConversation(accessToken: string, modelId: string, context: Context): { state: CursorConversationState; prompt: string } {
	const tokenHash = sha256Hex(accessToken);
	const prefixSignature = cursorCurrentPrefixSignature(context);
	const cacheKey = `${tokenHash}:${modelId}:${prefixSignature}`;
	const cached = cursorConversationStates.get(cacheKey);
	if (cached) {
		cached.lastUsedAt = Date.now();
		return { state: cached, prompt: cursorIncrementalPrompt(context) ?? buildCursorPrompt(context) };
	}

	const state: CursorConversationState = {
		tokenHash,
		modelId,
		conversationId: randomUUID(),
		prefixSignature,
		client: new AgentServiceClient(accessToken, {
			workspacePath: process.cwd(),
			privacyMode: true,
			baseUrl: CURSOR_API_URL,
		}),
		lastUsedAt: Date.now(),
	};
	pruneCursorConversationCache();
	return { state, prompt: buildCursorPrompt(context) };
}

function getCursorActiveRun(accessToken: string, modelId: string, context: Context): CursorActiveRun | undefined {
	if (context.messages.at(-1)?.role !== "toolResult") return undefined;
	const tokenHash = sha256Hex(accessToken);
	const prefixSignature = cursorContextSignature(context.systemPrompt, context.messages.slice(0, -1));
	const run = cursorActiveRuns.get(`${tokenHash}:${modelId}:${prefixSignature}`);
	if (run) run.lastUsedAt = Date.now();
	return run;
}

function startCursorActiveRun(state: CursorConversationState, prompt: string, modelId: string, tools?: Context["tools"], requestMeta?: CursorRequestMetadata): CursorActiveRun {
	const run: CursorActiveRun = {
		state,
		queue: new AsyncEventQueue<CursorApiStreamEvent>(),
		tools,
		...(requestMeta ? { requestMeta } : {}),
		lastUsedAt: Date.now(),
	};
	void pumpCursorActiveRun(run, prompt, modelId);
	return run;
}

async function pumpCursorActiveRun(run: CursorActiveRun, prompt: string, modelId: string): Promise<void> {
	try {
		const request = {
			message: prompt,
			model: modelId,
			mode: AgentMode.AGENT,
			conversationId: run.state.conversationId,
			...(run.state.checkpoint ? { checkpoint: run.state.checkpoint } : {}),
			tools: cursorToolDefinitions(run.tools),
			...run.requestMeta,
		};
		for await (const chunk of run.state.client.chatStream(request)) {
			if (chunk.type === "text" && chunk.content) run.queue.push({ type: "text", content: chunk.content });
			else if (chunk.type === "kv_blob_assistant" && chunk.blobContent) run.queue.push({ type: "text", content: chunk.blobContent });
			else if (chunk.type === "usage" && chunk.usage) run.queue.push({ type: "usage", usage: chunk.usage });
			else if (chunk.type === "checkpoint" && chunk.checkpoint) run.state.checkpoint = chunk.checkpoint;
			else if (chunk.type === "exec_request" && chunk.execRequest) {
				const toolCall = cursorExecRequestToToolCall(chunk.execRequest, run.tools);
				if (!toolCall) throw new Error(`Cursor requested unsupported tool: ${chunk.execRequest.type}`);
				run.pendingExecRequest = chunk.execRequest;
				run.queue.push({ type: "tool_call", id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments, execRequest: chunk.execRequest });
			} else if (chunk.type === "error") throw new Error(chunk.error);
			else if (chunk.type === "done") {
				run.queue.end();
				return;
			}
		}
		run.queue.end();
	} catch (error) {
		run.queue.fail(error);
	}
}

async function consumeCursorActiveRun(run: CursorActiveRun, stream: ReturnType<typeof createAssistantMessageEventStream>, output: AssistantMessage, context: Context, options?: SimpleStreamOptions): Promise<"stop" | "toolUse"> {
	let contentIndex: number | undefined;
	let assistantText = "";
	try {
		for await (const chunk of run.queue) {
			if (options?.signal?.aborted) throw new Error("Cursor request aborted.");
			if (chunk.type === "text") {
				if (!chunk.content) continue;
				assistantText += chunk.content;
				contentIndex = appendTextDelta(stream, output, chunk.content, contentIndex);
				continue;
			}
			if (chunk.type === "usage") {
				applyCursorUsage(output, chunk.usage);
				continue;
			}
			finishText(stream, output, contentIndex);
			emitToolCall(stream, output, chunk);
			rememberCursorToolConversation(run.state, context, assistantText, chunk);
			rememberCursorActiveRun(run, context, assistantText, chunk);
			return "toolUse";
		}
	} catch (error) {
		if (!assistantText || options?.signal?.aborted) throw error;
		// Cursor can finish a plain text turn but keep the AgentService bridge open
		// until a late transport timeout/cancel. The text is already visible in pi;
		// finalise it instead of surfacing an error that would trigger a replay.
	}
	finishText(stream, output, contentIndex);
	if (assistantText) rememberCursorConversation(run.state, context, assistantText);
	if (run.key) cursorActiveRuns.delete(run.key);
	return "stop";
}

function rememberCursorActiveRun(run: CursorActiveRun, context: Context, assistantText: string, toolCall: { name: string; arguments: Record<string, any> }): void {
	if (run.key) cursorActiveRuns.delete(run.key);
	run.key = `${run.state.tokenHash}:${run.state.modelId}:${cursorNextToolPrefixSignature(context, assistantText, toolCall)}`;
	run.lastUsedAt = Date.now();
	cursorActiveRuns.set(run.key, run);
	pruneCursorConversationCache();
}

async function resumeCursorActiveRun(run: CursorActiveRun, message: Context["messages"][number] | undefined): Promise<void> {
	if (message?.role !== "toolResult") throw new Error("Cursor active run can only resume from a tool result.");
	const execRequest = run.pendingExecRequest;
	if (!execRequest) throw new Error("Cursor active run has no pending tool request.");
	const content = message.content.map(blockToText).filter(Boolean).join("\n");
	if (execRequest.type === "shell") {
		await run.state.client.sendShellResult(execRequest.id, execRequest.execId, execRequest.command, execRequest.cwd || process.cwd(), message.isError ? "" : content, message.isError ? content : "", message.isError ? 1 : 0);
	} else if (execRequest.type === "mcp") {
		await run.state.client.sendToolResult(execRequest, message.isError ? { error: content } : { success: { content, isError: false } });
	} else if (execRequest.type === "read") {
		await run.state.client.sendReadResult(execRequest.id, execRequest.execId, content, execRequest.path);
	} else if (execRequest.type === "ls") {
		await run.state.client.sendLsResult(execRequest.id, execRequest.execId, content);
	} else {
		throw new Error(`Cursor active run cannot resume unsupported tool type: ${execRequest.type}`);
	}
	run.pendingExecRequest = undefined;
	// Cursor CLI's ClientExecController only streams ExecClientMessage results plus
	// ExecClientControlMessage.streamClose. A ConversationAction.resumeAction is
	// for external conversation resumption, not controlled tool execution; sending
	// it here can leave the backend heartbeat-only with no final answer.
}

function rememberCursorConversation(state: CursorConversationState, context: Context, assistantText: string): void {
	rememberCursorSignature(state, cursorNextPrefixSignature(context, assistantText));
}

function rememberCursorToolConversation(state: CursorConversationState, context: Context, assistantText: string, toolCall: { id: string; name: string; arguments: Record<string, any> }): void {
	rememberCursorSignature(state, cursorNextToolPrefixSignature(context, assistantText, toolCall));
}

function rememberCursorSignature(state: CursorConversationState, nextSignature: string): void {
	if (!nextSignature) return;
	const oldKey = `${state.tokenHash}:${state.modelId}:${state.prefixSignature}`;
	cursorConversationStates.delete(oldKey);
	state.prefixSignature = nextSignature;
	state.lastUsedAt = Date.now();
	cursorConversationStates.set(`${state.tokenHash}:${state.modelId}:${state.prefixSignature}`, state);
	pruneCursorConversationCache();
}

function pruneCursorConversationCache(): void {
	while (cursorConversationStates.size > CURSOR_CONVERSATION_CACHE_MAX) {
		let oldestKey: string | undefined;
		let oldestTime = Infinity;
		for (const [key, state] of cursorConversationStates) {
			if (state.lastUsedAt < oldestTime) {
				oldestTime = state.lastUsedAt;
				oldestKey = key;
			}
		}
		if (!oldestKey) return;
		cursorConversationStates.delete(oldestKey);
	}
}

function cursorCurrentPrefixSignature(context: Context): string {
	const messages = context.messages.at(-1)?.role === "user" ? context.messages.slice(0, -1) : context.messages;
	return cursorContextSignature(context.systemPrompt, messages);
}

function cursorNextPrefixSignature(context: Context, assistantText: string): string {
	return cursorSerializableContextSignature(context.systemPrompt, [
		...serializeCursorContextMessages(context.messages),
		{ role: "assistant", content: assistantText },
	]);
}

function cursorNextToolPrefixSignature(context: Context, assistantText: string, toolCall: { name: string; arguments: Record<string, any> }): string {
	const assistantParts = [assistantText, `TOOL_CALL ${toolCall.name}: ${JSON.stringify(toolCall.arguments ?? {})}`].filter(Boolean).join("\n");
	return cursorSerializableContextSignature(context.systemPrompt, [
		...serializeCursorContextMessages(context.messages),
		{ role: "assistant", content: assistantParts },
	]);
}

function cursorContextSignature(systemPrompt: string | undefined, messages: Context["messages"]): string {
	return cursorSerializableContextSignature(systemPrompt, serializeCursorContextMessages(messages));
}

function cursorSerializableContextSignature(systemPrompt: string | undefined, messages: Array<Record<string, string>>): string {
	return sha256Hex(JSON.stringify({
		systemPrompt: systemPrompt ?? "",
		messages,
	}));
}

function serializeCursorContextMessages(messages: Context["messages"]): Array<Record<string, string>> {
	return messages.map((message) => {
		if (message.role === "user") return { role: "user", content: messageContentToText(message.content) };
		if (message.role === "assistant") return { role: "assistant", content: message.content.map(blockToText).filter(Boolean).join("\n") };
		return { role: "tool", name: message.toolName, content: message.content.map(blockToText).filter(Boolean).join("\n") };
	});
}

function cursorIncrementalPrompt(context: Context): string | undefined {
	const last = context.messages.at(-1);
	return last?.role === "user" ? messageContentToText(last.content) : undefined;
}

function buildToolCallingPrompt(context: Context): string {
	return [
		"You are the model behind pi, a coding agent. Decide whether to call one of pi's tools or answer finally.",
		"",
		"Available tools:",
		context.tools?.map((tool) => `- ${tool.name}: ${tool.description} params=${JSON.stringify(stripSymbolKeys(tool.parameters)).slice(0, 1000)}`).join("\n") || "(none)",
		"",
		"Output exactly one JSON object and no markdown.",
		"To call tools: {\"action\":\"tool_call\",\"tool_calls\":[{\"name\":\"read\",\"arguments\":{\"path\":\"file.ts\"}}]}",
		"For a final answer: {\"action\":\"final\",\"content\":\"...\"}",
		"",
		"Conversation:",
		buildCursorPrompt(context),
	].join("\n");
}

function messageContentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map(blockToText).filter(Boolean).join("\n");
	return JSON.stringify(content ?? "");
}

function blockToText(block: any): string {
	if (!block) return "";
	if (block.type === "text") return block.text || "";
	if (block.type === "thinking") return block.thinking || "";
	if (block.type === "toolCall") return `TOOL_CALL ${block.name}: ${JSON.stringify(block.arguments ?? {})}`;
	if (block.type === "image") return "[image omitted: Cursor direct provider currently supports text only]";
	return "";
}

function emitText(stream: ReturnType<typeof createAssistantMessageEventStream>, output: AssistantMessage, text: string): void {
	const index = appendTextDelta(stream, output, text, undefined);
	finishText(stream, output, index);
}

function appendTextDelta(stream: ReturnType<typeof createAssistantMessageEventStream>, output: AssistantMessage, delta: string, contentIndex?: number): number {
	let index = contentIndex;
	if (index === undefined) {
		output.content.push({ type: "text", text: "" });
		index = output.content.length - 1;
		stream.push({ type: "text_start", contentIndex: index, partial: output });
	}
	const block = output.content[index];
	if (block?.type === "text") block.text += delta;
	stream.push({ type: "text_delta", contentIndex: index, delta, partial: output });
	return index;
}

function finishText(stream: ReturnType<typeof createAssistantMessageEventStream>, output: AssistantMessage, contentIndex?: number): void {
	if (contentIndex === undefined) return;
	const block = output.content[contentIndex];
	if (block?.type !== "text") return;
	stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
}

function appendThinkingDelta(stream: ReturnType<typeof createAssistantMessageEventStream>, output: AssistantMessage, delta: string, contentIndex?: number): number {
	let index = contentIndex;
	if (index === undefined) {
		output.content.push({ type: "thinking", thinking: "" });
		index = output.content.length - 1;
		stream.push({ type: "thinking_start", contentIndex: index, partial: output });
	}
	const block = output.content[index];
	if (block?.type === "thinking") block.thinking += delta;
	stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: output });
	return index;
}

function finishThinking(stream: ReturnType<typeof createAssistantMessageEventStream>, output: AssistantMessage, contentIndex?: number): void {
	if (contentIndex === undefined) return;
	const block = output.content[contentIndex];
	if (block?.type !== "thinking") return;
	stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
}

function emitToolCalls(stream: ReturnType<typeof createAssistantMessageEventStream>, output: AssistantMessage, toolCalls: Array<{ name: string; arguments?: unknown }>): void {
	for (const toolCall of toolCalls) {
		emitToolCall(stream, output, {
			id: `call_${randomUUID().replaceAll("-", "")}`,
			name: toolCall.name,
			arguments: normalizeToolArgs(toolCall.arguments),
		});
	}
}

function emitToolCall(stream: ReturnType<typeof createAssistantMessageEventStream>, output: AssistantMessage, toolCall: { id: string; name: string; arguments: Record<string, any> }): void {
	output.stopReason = "toolUse";
	const argsJson = JSON.stringify(toolCall.arguments);
	const block = { type: "toolCall" as const, id: toolCall.id || `call_${randomUUID().replaceAll("-", "")}`, name: toolCall.name, arguments: toolCall.arguments };
	output.content.push(block);
	const contentIndex = output.content.length - 1;
	stream.push({ type: "toolcall_start", contentIndex, partial: output });
	stream.push({ type: "toolcall_delta", contentIndex, delta: argsJson, partial: output });
	stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
}

function normalizeToolArgs(value: unknown): Record<string, any> {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
	return {};
}

async function collectCursorApiText(accessToken: string, prompt: string, model: string, signal?: AbortSignal, requestMeta?: CursorRequestMetadata): Promise<string> {
	let text = "";
	for await (const chunk of streamCursorApiEvents(accessToken, prompt, model, signal, undefined, undefined, requestMeta)) {
		if (chunk.type === "text") text += chunk.content;
	}
	return text;
}

async function* streamCursorApiEvents(accessToken: string, prompt: string, model: string, signal?: AbortSignal, conversation?: CursorConversationState, tools?: Context["tools"], requestMeta?: CursorRequestMetadata): AsyncGenerator<CursorApiStreamEvent> {
	const client = conversation?.client ?? new AgentServiceClient(accessToken, {
		workspacePath: process.cwd(),
		privacyMode: true,
		baseUrl: CURSOR_API_URL,
	});
	const request = {
		message: prompt,
		model,
		mode: AgentMode.AGENT,
		...(conversation?.conversationId ? { conversationId: conversation.conversationId } : {}),
		...(conversation?.checkpoint ? { checkpoint: conversation.checkpoint } : {}),
		...(signal ? { signal } : {}),
		tools: cursorToolDefinitions(tools),
		...requestMeta,
	};
	for await (const chunk of client.chatStream(request)) {
		if (signal?.aborted) throw new Error("Cursor request aborted.");
		if (chunk.type === "text" && chunk.content) yield { type: "text", content: chunk.content };
		else if (chunk.type === "kv_blob_assistant" && chunk.blobContent) yield { type: "text", content: chunk.blobContent };
		else if (chunk.type === "usage" && chunk.usage) yield { type: "usage", usage: chunk.usage };
		else if (chunk.type === "exec_request" && chunk.execRequest) {
			const toolCall = cursorExecRequestToToolCall(chunk.execRequest, tools);
			if (!toolCall) throw new Error(`Cursor requested unsupported tool: ${chunk.execRequest.type}`);
			yield toolCall;
			return;
		} else if (chunk.type === "checkpoint" && chunk.checkpoint && conversation) {
			conversation.checkpoint = chunk.checkpoint;
		} else if (chunk.type === "error") throw new Error(chunk.error);
		else if (chunk.type === "done") return;
	}
}

function cursorRequestMetadata(model: Model<Api>, context: Context, _options?: SimpleStreamOptions): CursorRequestMetadata {
	const modelId = normalizeCursorModel(model.id);
	return {
		modelDisplayName: model.name || modelId,
		...(context.systemPrompt?.trim() ? { systemPrompt: context.systemPrompt.trim() } : {}),
		requestedModel: {
			modelId,
			maxMode: process.env.PI_CURSOR_MAX_MODE === "1",
			parameters: [],
		},
	};
}

function cursorToolDefinitions(tools?: Context["tools"]): Array<{ type: "function"; function: { name: string; description?: string; parameters?: Record<string, unknown> } }> {
	return (tools ?? []).map((tool: any) => ({
		type: "function" as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: stripSymbolKeys(tool.parameters) as Record<string, unknown>,
		},
	}));
}

function cursorExecRequestToToolCall(execRequest: any, tools?: Context["tools"]): Extract<CursorApiStreamEvent, { type: "tool_call" }> | undefined {
	const available = new Set((tools ?? []).map((tool: any) => tool.name));
	const hasTool = (name: string) => available.size === 0 || available.has(name);
	const id = `call_cursor_${String(execRequest.execId || execRequest.id || randomUUID()).replace(/[^A-Za-z0-9_-]/g, "")}`;

	if (execRequest.type === "mcp") {
		const name = execRequest.toolName || execRequest.name;
		if (!name || !hasTool(name)) return undefined;
		return { type: "tool_call", id, name, arguments: normalizeToolArgs(execRequest.args) };
	}
	if (execRequest.type === "shell" && hasTool("bash")) {
		return { type: "tool_call", id, name: "bash", arguments: { command: execRequest.command } };
	}
	if (execRequest.type === "ls" && hasTool("ls")) {
		return { type: "tool_call", id, name: "ls", arguments: { path: execRequest.path } };
	}
	if (execRequest.type === "read" && hasTool("read")) {
		return { type: "tool_call", id, name: "read", arguments: { path: execRequest.path } };
	}
	if (execRequest.type === "grep" && hasTool("grep")) {
		return { type: "tool_call", id, name: "grep", arguments: compactObject({ pattern: execRequest.pattern, path: execRequest.path, glob: execRequest.glob }) };
	}
	if (execRequest.type === "write" && hasTool("write")) {
		return { type: "tool_call", id, name: "write", arguments: { path: execRequest.path, content: execRequest.fileText ?? "" } };
	}
	return undefined;
}

function parseCursorToolArguments(value: unknown): Record<string, any> {
	if (!value) return {};
	if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
	if (typeof value !== "string") return {};
	try {
		return normalizeToolArgs(JSON.parse(value));
	} catch {
		return {};
	}
}

function compactObject<T extends Record<string, any>>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== "")) as T;
}

function detectCursorClientVersion(): string | undefined {
	const candidates = [
		"/Applications/Cursor.app/Contents/Resources/app/product.json",
		join(homedir(), "Applications", "Cursor.app", "Contents", "Resources", "app", "product.json"),
		"/usr/share/cursor/resources/app/product.json",
		"/opt/Cursor/resources/app/product.json",
		join(process.env.LOCALAPPDATA || "", "Programs", "Cursor", "resources", "app", "product.json"),
	];
	for (const candidate of candidates) {
		if (!candidate || !existsSync(candidate)) continue;
		try {
			const product = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
			if (typeof product.version === "string" && product.version.trim()) return product.version.trim();
		} catch {}
	}
	return undefined;
}

function sha256Hex(value: string, salt = ""): string {
	return createHash("sha256").update(value + salt).digest("hex");
}

function parseToolCallPlan(output: string): ToolCallPlan | null {
	const start = output.indexOf("{");
	const end = output.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const parsed = JSON.parse(output.slice(start, end + 1)) as ToolCallPlan;
		if (parsed.action === "final" && typeof parsed.content === "string") return parsed;
		if (parsed.action === "tool_call" && Array.isArray(parsed.tool_calls)) return parsed;
	} catch {}
	return null;
}

function normalizeCursorModel(modelId?: string): string {
	if (!modelId || modelId === "cursor" || modelId === "auto") return DEFAULT_MODEL;
	// Cursor's live subscription list exposes GPT-5.5 as explicit effort slugs.
	// Keep cursor/gpt-5.5 as a friendly "ordinary" alias, but route it to the
	// no-extra-thinking variant that the AgentService actually serves.
	if (modelId === "gpt-5.5") return "gpt-5.5-none";
	return modelId;
}

function createPkce(): { verifier: string; challenge: string } {
	const verifier = randomBytes(96).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

function buildCursorLoginUrl(challenge: string, uuid: string): string {
	const params = new URLSearchParams({
		challenge,
		uuid,
		mode: "login",
		redirectTarget: "cli",
	});
	return `${CURSOR_LOGIN_URL}?${params}`;
}

async function pollCursorAuth(uuid: string, verifier: string, signal?: AbortSignal): Promise<{ accessToken: string; refreshToken: string }> {
	let delay = POLL_BASE_DELAY_MS;
	for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
		await sleep(delay, signal);
		const response = await fetch(`${CURSOR_POLL_URL}?${new URLSearchParams({ uuid, verifier })}`, signal ? { signal } : undefined);
		if (response.status === 404) {
			delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY_MS);
			continue;
		}
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`Cursor authorization poll failed: HTTP ${response.status}${body ? ` ${body}` : ""}`);
		}
		const data = await response.json() as { accessToken?: string; refreshToken?: string };
		if (!data.accessToken || !data.refreshToken) throw new Error("Cursor authorization did not return access and refresh tokens.");
		return { accessToken: data.accessToken, refreshToken: data.refreshToken };
	}
	throw new Error("Timed out waiting for Cursor authorization.");
}

function cursorCredentialsFromToken(access: string, refresh: string): OAuthCredentials {
	return { access, refresh, expires: getTokenExpiry(access) };
}

function getTokenExpiry(token: string): number {
	try {
		const parts = token.split(".");
		if (parts.length === 3 && parts[1]) {
			const payload = JSON.parse(Buffer.from(parts[1].replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8")) as { exp?: unknown };
			if (typeof payload.exp === "number") return payload.exp * 1000 - REFRESH_SKEW_MS;
		}
	} catch {}
	return Date.now() + FALLBACK_EXPIRY_MS;
}

function looksLikeJwt(value: unknown): value is string {
	return typeof value === "string" && value.split(".").length === 3;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new Error("Cursor authorization cancelled."));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		if (!signal) return;
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Cursor authorization cancelled."));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function stripSymbolKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => stripSymbolKeys(item));
	if (value && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) result[key] = stripSymbolKeys(entry);
		return result;
	}
	return value;
}
