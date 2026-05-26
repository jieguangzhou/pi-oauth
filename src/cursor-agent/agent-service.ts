// @ts-nocheck
/**
 * Cursor Agent Service Client
 *
 * Derived from/reconciled against MIT-licensed Cursor protocol research from
 * Yukaii/yet-another-opencode-cursor-auth and validated against Cursor CLI's
 * bundled AgentService/BidiAppend flow.
 *
 * Implements the AgentService API for chat functionality.
 * Uses the BidiSse pattern:
 * - RunSSE (server-streaming) to receive responses
 * - BidiAppend (unary) to send client messages
 *
 * Proto structure:
 * AgentClientMessage:
 *   field 1: run_request (AgentRunRequest)
 *   field 2: exec_client_message (ExecClientMessage)
 *   field 3: kv_client_message (KvClientMessage)
 *   field 4: conversation_action (ConversationAction)
 *   field 5: exec_client_control_message
 *   field 6: interaction_response
 *
 * AgentServerMessage:
 *   field 1: interaction_update (InteractionUpdate)
 *   field 2: exec_server_message (ExecServerMessage)
 *   field 3: conversation_checkpoint_update (completion signal)
 *   field 4: kv_server_message (KvServerMessage)
 *   field 5: exec_server_control_message
 *   field 7: interaction_query
 *
 * InteractionUpdate.message:
 *   field 1: text_delta
 *   field 4: thinking_delta
 *   field 8: token_delta
 *   field 13: heartbeat
 *   field 14: turn_ended
 */

import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { connect as connectHttp2 } from "node:http2";
import { homedir } from "node:os";
import { join } from "node:path";
import { addConnectEnvelope } from "./cursor-client.js";
import {
  encodeMessageField,
  parseProtoFields,
  parseExecServerMessage,
  buildExecClientMessageWithMcpResult,
  buildExecClientMessageWithShellResult,
  buildExecClientMessageWithLsResult,
  buildExecClientMessageWithRequestContextResult,
  buildExecClientMessageWithReadResult,
  buildExecClientMessageWithGrepResult,
  buildExecClientMessageWithWriteResult,
  buildAgentClientMessageWithExec,
  buildExecClientControlMessage,
  buildAgentClientMessageWithExecControl,
  parseKvServerMessage,
  buildKvClientMessage,
  buildAgentClientMessageWithKv,
  AgentMode,
  encodeBidiRequestId,
  encodeBidiAppendRequest,
  buildRequestContext,
  encodeUserMessage,
  encodeUserMessageAction,
  encodeConversationAction,
  encodeConversationActionWithResume,
  encodeAgentClientMessageWithConversationAction,
  encodeModelDetails,
  encodeRequestedModel,
  encodeAgentRunRequest,
  encodeAgentClientMessage,
  parseInteractionUpdate,
  analyzeBlobData,
  extractAssistantContent,
} from "./proto/index.js";
import type {
  OpenAIToolDefinition,
  McpExecRequest,
  ExecRequest,
  KvServerMessage,
  ChatTimingMetrics,
  AgentServiceOptions,
  AgentChatRequest,
  ToolCallInfo,
  AgentStreamChunk as AgentStreamChunkType,
} from "./proto/types.js";

// Re-export types that external code may need
export { AgentMode };
export type AgentStreamChunk = AgentStreamChunkType;
export type { ExecRequest, McpExecRequest, ToolCallInfo, OpenAIToolDefinition };

// Debug logging - set to true to enable verbose logging
const DEBUG = process.env.CURSOR_DEBUG === "1";
const debugLog = DEBUG ? console.log.bind(console) : () => {};

// Performance timing - set CURSOR_TIMING=1 to enable timing logs (or CURSOR_DEBUG=1)
const TIMING_ENABLED = process.env.CURSOR_TIMING === "1" || DEBUG;
const timingLog = TIMING_ENABLED ? console.log.bind(console) : () => {};


function createTimingMetrics(): ChatTimingMetrics {
  return {
    requestStart: Date.now(),
    chunkCount: 0,
    textChunks: 0,
    toolCalls: 0,
    execRequests: 0,
    kvMessages: 0,
    heartbeats: 0,
  };
}

function logTimingMetrics(metrics: ChatTimingMetrics): void {
  const total = Date.now() - metrics.requestStart;
  metrics.totalMs = total;
  
  timingLog("[TIMING] ═══════════════════════════════════════════════════════");
  timingLog("[TIMING] Request Performance Summary");
  timingLog("[TIMING] ───────────────────────────────────────────────────────");
  timingLog(`[TIMING]   Message build:     ${metrics.messageBuildMs ?? "-"}ms`);
  timingLog(`[TIMING]   SSE connection:    ${metrics.sseConnectionMs ?? "-"}ms`);
  timingLog(`[TIMING]   First BidiAppend:  ${metrics.firstBidiAppendMs ?? "-"}ms`);
  timingLog(`[TIMING]   First chunk:       ${metrics.firstChunkMs ?? "-"}ms`);
  timingLog(`[TIMING]   First text:        ${metrics.firstTextMs ?? "-"}ms`);
  timingLog(`[TIMING]   First tool call:   ${metrics.firstToolCallMs ?? "-"}ms`);
  timingLog(`[TIMING]   Turn ended:        ${metrics.turnEndedMs ?? "-"}ms`);
  timingLog(`[TIMING]   Total:             ${total}ms`);
  timingLog("[TIMING] ───────────────────────────────────────────────────────");
  timingLog(`[TIMING]   Chunks: ${metrics.chunkCount} (text: ${metrics.textChunks}, tools: ${metrics.toolCalls})`);
  timingLog(`[TIMING]   Exec requests: ${metrics.execRequests}, KV messages: ${metrics.kvMessages}`);
  timingLog(`[TIMING]   Heartbeats: ${metrics.heartbeats}`);
  timingLog("[TIMING] ═══════════════════════════════════════════════════════");
}

// Cursor API URL (main API)
export const CURSOR_API_URL = "https://api2.cursor.sh";

// Agent backends
export const AGENT_PRIVACY_URL = "https://agent.api5.cursor.sh";
export const AGENT_NON_PRIVACY_URL = "https://agentn.api5.cursor.sh";

let cachedAgentVersion: string | undefined | null = null; // null = not yet detected

function detectLatestInstalledAgentVersion(): string | undefined {
  if (cachedAgentVersion !== null) return cachedAgentVersion;
  try {
    const versionsDir = join(homedir(), ".local", "share", "cursor-agent", "versions");
    const entries = readdirSync(versionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

    const latest = entries.at(-1);
    cachedAgentVersion = latest ? `cli-${latest}` : undefined;
    return cachedAgentVersion;
  } catch {
    cachedAgentVersion = undefined;
    return undefined;
  }
}

let cachedClientVersionHeader: string | null = null;

function resolveClientVersionHeader(): string {
  if (cachedClientVersionHeader) return cachedClientVersionHeader;
  cachedClientVersionHeader = process.env.CURSOR_CLIENT_VERSION ?? detectLatestInstalledAgentVersion() ?? "cli-unknown";
  return cachedClientVersionHeader;
}

function parseConnectEndStreamError(frameData: Uint8Array): string | undefined {
  if (frameData.length === 0) return undefined;
  const text = new TextDecoder().decode(frameData).trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
    const message = parsed.error?.message;
    if (message) return parsed.error?.code ? `${message} (${parsed.error.code})` : message;
  } catch {
    // Non-JSON EndStreamResponse payloads are ignored here; trailers are parsed separately.
  }
  return undefined;
}

function parseTrailerMetadata(trailer: string): Record<string, string> {
  const meta: Record<string, string> = {};

  for (const rawLine of trailer.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;

    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    meta[key] = value;
  }

  return meta;
}

function decodeGrpcStatusDetailsBin(detailsB64: string): string | undefined {
  try {
    const decoded = Buffer.from(detailsB64.trim(), "base64");
    const statusFields = parseProtoFields(decoded);

    let statusMessage: string | undefined;
    const extracted: string[] = [];

    const collectStrings = (bytes: Uint8Array, depth: number): void => {
      if (depth > 5) return;
      if (bytes.length === 0 || bytes.length > 20000) return;

      for (const pf of parseProtoFields(bytes)) {
        if (pf.wireType === 2 && pf.value instanceof Uint8Array) {
          const maybeText = new TextDecoder().decode(pf.value).trim();
          if (
            maybeText.length >= 6 &&
            /[A-Za-z]/.test(maybeText) &&
            !maybeText.includes("\u0000")
          ) {
            extracted.push(maybeText);
          }
          collectStrings(pf.value, depth + 1);
        }
      }
    };

    for (const field of statusFields) {
      // google.rpc.Status.message = field 2
      if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
        const text = new TextDecoder().decode(field.value).trim();
        if (text) statusMessage = text;
      }

      // google.rpc.Status.details (repeated Any) = field 3
      if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
        const anyFields = parseProtoFields(field.value);
        const valueField = anyFields.find((f) => f.fieldNumber === 2 && f.wireType === 2);
        if (!valueField || !(valueField.value instanceof Uint8Array)) continue;

        // Try to extract human-readable strings from the Any.value payload
        collectStrings(valueField.value, 0);
      }
    }

    const unique = Array.from(new Set(extracted));
    const details = unique.length > 0 ? unique.join(" | ") : undefined;

    if (details && statusMessage) return `${statusMessage} | ${details}`;
    return details ?? statusMessage;
  } catch {
    return undefined;
  }
}

// --- Types are now imported from ./proto ---
// ExecRequest types, ToolCallInfo, AgentStreamChunk, AgentServiceOptions, AgentChatRequest
// are all imported from ./proto/types via the barrel export

// Local aliases for the buildExecClientMessageWithMcpResult function which needs a slightly different signature
function buildExecClientMessage(
  id: number,
  execId: string | undefined,
  result: { success?: { content: string; isError?: boolean }; error?: string }
): Uint8Array {
  return buildExecClientMessageWithMcpResult(id, execId, result);
}

const ALIGN_MIN_BUFFER_BYTES = 32;
const ALIGN_MAX_BUFFER_BYTES = 4096;

/**
 * Decide how much of `pending` overlaps with the trailing `unsafe` window that
 * was already streamed to the consumer before a mid-stream drop, so the caller
 * can yield `pending.slice(skip)` and avoid duplicates.
 *
 * Semantics:
 *  - Cursor's Resume action picks up from the server-side checkpoint. The
 *    consumer has already seen `yieldedText`, the last `unsafe` chars of which
 *    sit after that checkpoint and could be replayed.
 *  - Resume may emit (a) a clean continuation, (b) a partial replay of the
 *    last few tokens then continuation, or (c) a full replay of `unsafe` then
 *    continuation. The longest suffix-of-`unsafe`-that-is-prefix-of-`pending`
 *    captures all three.
 *
 * Returns null when we should wait for more pending bytes before deciding.
 * `force` forces a decision (used at stream end / error fallback) regardless
 * of how little we have.
 */
export function decideAlignment(unsafe: string, pending: string, force: boolean): { skip: number } | null {
  if (unsafe.length === 0) return { skip: 0 };
  if (pending.length === 0) return force ? { skip: 0 } : null;

  // Wait if pending is still building toward a possible full replay
  // (pending is currently a prefix of unsafe and we haven't seen anything new).
  if (!force && pending.length < unsafe.length && unsafe.startsWith(pending)) {
    if (pending.length >= ALIGN_MAX_BUFFER_BYTES) return { skip: pending.length };
    return null;
  }

  const maxK = Math.min(unsafe.length, pending.length);
  let k = 0;
  for (let candidate = maxK; candidate > 0; candidate--) {
    if (unsafe.slice(unsafe.length - candidate) === pending.slice(0, candidate)) {
      k = candidate;
      break;
    }
  }

  if (force) return { skip: k };
  if (pending.length >= ALIGN_MIN_BUFFER_BYTES) return { skip: k };
  if (pending.length >= unsafe.length) return { skip: k };
  if (pending.length >= ALIGN_MAX_BUFFER_BYTES) return { skip: k };
  return null;
}

export class AgentServiceClient {
  private baseUrl: string;
  private accessToken: string;
  private workspacePath: string;
  private blobStore: Map<string, Uint8Array>;
  private currentTools?: OpenAIToolDefinition[];
  private currentSystemPrompt?: string;
  private privacyMode = true;
  private clientVersionHeader = "cli-unknown";
  private baseUrlAttempts: string[] | null = null;

  // For tool result submission during streaming
  private currentRequestId: string | null = null;
  private currentAppendSeqno = 0n;
  private currentH2Stream: any | null = null;
  private appendChain: Promise<void> = Promise.resolve();
  
  // For session reuse - track assistant responses stored in KV blobs
  // When Cursor stores model responses in blobs instead of streaming, we need to extract them
  private pendingAssistantBlobs: Array<{ blobId: string; content: string }> = [];

  constructor(accessToken: string, options: AgentServiceOptions = {}) {
    this.accessToken = accessToken;
    this.privacyMode = options.privacyMode ?? true;
    this.clientVersionHeader = resolveClientVersionHeader();

    // Default to api2, but allow fallback to agent backends if needed
    this.baseUrl = options.baseUrl ?? CURSOR_API_URL;
    this.workspacePath = options.workspacePath ?? process.cwd();
    this.blobStore = new Map();

    debugLog(
      `[DEBUG] AgentServiceClient using baseUrl: ${this.baseUrl}, privacyMode=${this.privacyMode}, clientVersion=${this.clientVersionHeader}`
    );
  }

  private getHeaders(requestId?: string, kind: "stream" | "unary" = "stream"): Record<string, string> {
    const headers: Record<string, string> = {
      "authorization": `Bearer ${this.accessToken}`,
      // Match Cursor CLI's Connect protocol path. RunSSE is a Connect streaming
      // request, while BidiAppend is a Connect unary request.
      "content-type": kind === "unary" ? "application/proto" : "application/connect+proto",
      "connect-protocol-version": "1",
      "user-agent": "connect-es/1.6.1",
      "x-cursor-client-version": this.clientVersionHeader,
      "x-cursor-client-type": "cli",
      "x-ghost-mode": this.privacyMode ? "true" : "false",
      // Signal to backend that we can receive SSE text/event-stream responses.
      // Cursor CLI sets this on the Agent transport in HTTP/1.1 mode.
      "x-cursor-streaming": "true",
    };

    if (process.env.CURSOR_AGENT_CLI_LOCAL_MODE === "true") {
      headers["local-cli-mode"] = "true";
    }

    if (requestId) {
      headers["x-request-id"] = requestId;
      // Cursor CLI sends both request id and original request id on the first
      // attempt; retries receive a new request id but retain the original.
      headers["x-original-request-id"] = requestId;
    }

    return headers;
  }

  private getBaseUrlAttempts(): string[] {
    if (this.baseUrlAttempts) return this.baseUrlAttempts;

    const orderedCandidates: string[] = [this.baseUrl];

    // Cursor can route AgentService/BidiService to agent.api5.cursor.sh, but those
    // backends often require HTTP/2. Bun's fetch currently struggles with that,
    // so only attempt api5 fallbacks when explicitly enabled.
    const allowApi5Fallback = process.env.CURSOR_AGENT_TRY_API5 === "1";
    const isBunRuntime =
      typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

    if (allowApi5Fallback && !isBunRuntime) {
      if (this.baseUrl === CURSOR_API_URL) {
        orderedCandidates.push(
          this.privacyMode ? AGENT_PRIVACY_URL : AGENT_NON_PRIVACY_URL
        );
        orderedCandidates.push(
          this.privacyMode ? AGENT_NON_PRIVACY_URL : AGENT_PRIVACY_URL
        );
      } else if (
        this.baseUrl === AGENT_PRIVACY_URL ||
        this.baseUrl === AGENT_NON_PRIVACY_URL
      ) {
        orderedCandidates.push(CURSOR_API_URL);
      }
    }

    this.baseUrlAttempts = Array.from(new Set(orderedCandidates));
    return this.baseUrlAttempts;
  }

  private blobIdToKey(blobId: Uint8Array): string {
    return Buffer.from(blobId).toString('hex');
  }

  /**
   * Build the AgentClientMessage for a chat request
   */
  private buildChatMessage(request: AgentChatRequest): Uint8Array {
    const messageId = randomUUID();
    const conversationId = request.conversationId ?? randomUUID();
    const model = request.model ?? "gpt-4o";
    const mode = request.mode ?? AgentMode.AGENT;
    const requestedModelInput = request.requestedModel ?? { modelId: model, maxMode: false, parameters: [] };

    // Build RequestContext (REQUIRED for agent to work). Pi's system prompt is
    // mapped to Cursor rules, which is Cursor's supported user-facing mechanism
    // for system-level Agent instructions.
    // Include tools in RequestContext.tools (field 7) - CRITICAL for tool calling!
    this.currentTools = request.tools;
    this.currentSystemPrompt = request.systemPrompt;
    const requestContext = buildRequestContext(this.workspacePath, request.tools, request.systemPrompt);

    // Build the message hierarchy. Cursor CLI retries dropped streams by
    // re-sending the latest checkpoint with ConversationAction.resumeAction,
    // not by replaying the original user prompt.
    let conversationAction: Uint8Array;
    if (request.action === "resume") {
      conversationAction = encodeConversationActionWithResume(requestContext);
    } else {
      const userMessage = encodeUserMessage(request.message, messageId, mode);
      const userMessageAction = encodeUserMessageAction(userMessage, requestContext);
      conversationAction = encodeConversationAction(userMessageAction);
    }
    const modelDetails = encodeModelDetails(model, request.modelDisplayName ?? model);
    const requestedModel = encodeRequestedModel(
      requestedModelInput.modelId,
      Boolean(requestedModelInput.maxMode),
      requestedModelInput.parameters ?? []
    );
    // Pass tools to AgentRunRequest (field 4: mcp_tools), workspace path (field 6),
    // and requested_model (field 9) to match Cursor CLI's AgentRunRequest shape.
    // Do not send AgentRunRequest field 8: the CLI exposes it only as a hidden
    // internal option and normal accounts reject it as --system-prompt.
    const agentRunRequest = encodeAgentRunRequest(conversationAction, modelDetails, conversationId, request.tools, this.workspacePath, request.checkpoint, requestedModel);
    const agentClientMessage = encodeAgentClientMessage(agentRunRequest);

    return agentClientMessage;
  }

  /**
   * Call BidiAppend to send a client message
   */
  private async bidiAppend(requestId: string, appendSeqno: bigint, data: Uint8Array): Promise<void> {
    const startTime = DEBUG ? Date.now() : 0;
    const hexData = Buffer.from(data).toString("hex");
    const appendRequest = encodeBidiAppendRequest(hexData, requestId, appendSeqno);

    debugLog(`[TIMING] bidiAppend: data=${data.length}bytes, hex=${hexData.length}chars, unary=${appendRequest.length}bytes, encode=${Date.now() - startTime}ms`);

    const url = `${this.baseUrl}/aiserver.v1.BidiService/BidiAppend`;

    const fetchStart = DEBUG ? Date.now() : 0;
    const response = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(requestId, "unary"),
      body: Buffer.from(appendRequest),
    });
    debugLog(`[TIMING] bidiAppend fetch took ${Date.now() - fetchStart}ms, status=${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`BidiAppend failed: ${response.status} - ${errorText}`);
    }

    // Only read and parse the response body when debug logging is enabled
    if (DEBUG) {
      const responseBody = await response.arrayBuffer();
      if (responseBody.byteLength > 0) {
        debugLog(`[DEBUG] BidiAppend response: ${responseBody.byteLength} bytes`);
        const bytes = new Uint8Array(responseBody);
        if (bytes.length >= 5) {
          const flags = bytes[0] ?? 0;
          const b1 = bytes[1] ?? 0;
          const b2 = bytes[2] ?? 0;
          const b3 = bytes[3] ?? 0;
          const b4 = bytes[4] ?? 0;
          const length = (b1 << 24) | (b2 << 16) | (b3 << 8) | b4;
          debugLog(`[DEBUG] BidiAppend response: flags=${flags}, length=${length}, totalBytes=${bytes.length}`);
          if (length > 0 && bytes.length >= 5 + length) {
            const payload = bytes.slice(5, 5 + length);
            debugLog(`[DEBUG] BidiAppend payload hex: ${Buffer.from(payload).toString('hex')}`);
          }
        }
      }
    }
  }

  private async sendActiveClientMessage(data: Uint8Array): Promise<void> {
    const append = this.appendChain.then(async () => {
      if (!this.currentRequestId) {
        throw new Error("No active chat stream - cannot send client message");
      }
      if (this.currentH2Stream) {
        await this.writeH2ClientMessage(data);
        return;
      }
      const requestId = this.currentRequestId;
      const appendSeqno = this.currentAppendSeqno;
      this.currentAppendSeqno++;
      await this.bidiAppend(requestId, appendSeqno, data);
    });
    this.appendChain = append.catch(() => {});
    await append;
  }

  private async writeH2ClientMessage(data: Uint8Array): Promise<void> {
    const stream = this.currentH2Stream;
    if (!stream) throw new Error("No active HTTP/2 chat stream - cannot send client message");
    const frame = Buffer.from(addConnectEnvelope(data));
    if (stream.destroyed || stream.closed) throw new Error("HTTP/2 chat stream is closed");
    if (stream.write(frame)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        stream.off?.("drain", onDrain);
        stream.off?.("error", onError);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (error: unknown) => {
        cleanup();
        reject(error);
      };
      stream.once?.("drain", onDrain);
      stream.once?.("error", onError);
    });
  }

  private async handleKvMessage(
    kvMsg: KvServerMessage
  ): Promise<void> {
    if (kvMsg.messageType === 'get_blob_args' && kvMsg.blobId) {
      const key = this.blobIdToKey(kvMsg.blobId);
      const data = this.blobStore.get(key);

      const result = data ? encodeMessageField(1, data) : new Uint8Array(0);
      const kvClientMsg = buildKvClientMessage(kvMsg.id, 'get_blob_result', result);
      const responseMsg = buildAgentClientMessageWithKv(kvClientMsg);

      await this.sendActiveClientMessage(responseMsg);
      return;
    }

    if (kvMsg.messageType === 'set_blob_args' && kvMsg.blobId && kvMsg.blobData) {
      const key = this.blobIdToKey(kvMsg.blobId);
      this.blobStore.set(key, kvMsg.blobData);

      const blobAnalysis = analyzeBlobData(kvMsg.blobData);
      debugLog(`[KV-BLOB] SET id=${kvMsg.id}, key=${key.slice(0, 16)}..., size=${kvMsg.blobData.length}b, type=${blobAnalysis.type}`);
      
      if (blobAnalysis.type === 'json' && blobAnalysis.json) {
        const json = blobAnalysis.json as Record<string, unknown>;
        debugLog(`[KV-BLOB] JSON keys: ${Object.keys(json).join(', ')}`);
        if (json.role) debugLog(`[KV-BLOB] JSON role: ${json.role}`);
        if (json.content) debugLog(`[KV-BLOB] JSON content type: ${typeof json.content}, isArray: ${Array.isArray(json.content)}`);
      }
      
      const extractedContent = extractAssistantContent(blobAnalysis, key);
      for (const item of extractedContent) {
        debugLog(`[KV-BLOB]   ✓ Assistant content found: ${item.content.slice(0, 100)}...`);
        this.pendingAssistantBlobs.push(item);
      }

      const result = new Uint8Array(0);
      const kvClientMsg = buildKvClientMessage(kvMsg.id, 'set_blob_result', result);
      const responseMsg = buildAgentClientMessageWithKv(kvClientMsg);

      await this.sendActiveClientMessage(responseMsg);
      return;
    }
    return;
  }

  /**
   * Send a tool result back to the server (for MCP tools only)
   * This must be called during an active chat stream when an exec_request chunk is received
   */
  async sendToolResult(
    execRequest: McpExecRequest & { type: 'mcp' },
    result: { success?: { content: string; isError?: boolean }; error?: string }
  ): Promise<void> {
    if (!this.currentRequestId) {
      throw new Error("No active chat stream - cannot send tool result");
    }

    debugLog("[DEBUG] Sending tool result for exec id:", execRequest.id, "result:", result.success ? "success" : "error");

    // Build ExecClientMessage with mcp_result
    const execClientMsg = buildExecClientMessage(
      execRequest.id,
      execRequest.execId,
      result
    );
    const responseMsg = buildAgentClientMessageWithExec(execClientMsg);

    // Send the result
    await this.sendActiveClientMessage(responseMsg);

    debugLog("[DEBUG] Tool result sent, new seqno:", this.currentAppendSeqno);

    // Send stream close control message
    const controlMsg = buildExecClientControlMessage(execRequest.id);
    const controlResponseMsg = buildAgentClientMessageWithExecControl(controlMsg);

    await this.sendActiveClientMessage(controlResponseMsg);

    debugLog("[DEBUG] Stream close sent for exec id:", execRequest.id);
  }

  /**
   * Send a shell execution result back to the server
   */
  async sendShellResult(
    id: number,
    execId: string | undefined,
    command: string,
    cwd: string,
    stdout: string,
    stderr: string,
    exitCode: number,
    executionTimeMs?: number
  ): Promise<void> {
    if (!this.currentRequestId) {
      throw new Error("No active chat stream - cannot send shell result");
    }

    debugLog("[DEBUG] Sending shell result for id:", id, "exitCode:", exitCode);

    const execClientMsg = buildExecClientMessageWithShellResult(id, execId, command, cwd, stdout, stderr, exitCode, executionTimeMs);
    const responseMsg = buildAgentClientMessageWithExec(execClientMsg);

    await this.sendActiveClientMessage(responseMsg);

    // Send stream close control message
    const controlMsg = buildExecClientControlMessage(id);
    const controlResponseMsg = buildAgentClientMessageWithExecControl(controlMsg);

    await this.sendActiveClientMessage(controlResponseMsg);

    debugLog("[DEBUG] Stream close sent for exec id:", id);
  }

  /**
   * Send an LS result back to the server
   */
  async sendLsResult(id: number, execId: string | undefined, filesString: string): Promise<void> {
    if (!this.currentRequestId) {
      throw new Error("No active chat stream - cannot send ls result");
    }

    debugLog("[DEBUG] Sending ls result for id:", id);

    const execClientMsg = buildExecClientMessageWithLsResult(id, execId, filesString);
    const responseMsg = buildAgentClientMessageWithExec(execClientMsg);

    await this.sendActiveClientMessage(responseMsg);

    // Send stream close control message
    const controlMsg = buildExecClientControlMessage(id);
    const controlResponseMsg = buildAgentClientMessageWithExecControl(controlMsg);

    await this.sendActiveClientMessage(controlResponseMsg);

    debugLog("[DEBUG] Stream close sent for exec id:", id);
  }

  /**
   * Send a request context result back to the server
   */
  async sendRequestContextResult(id: number, execId: string | undefined): Promise<void> {
    if (!this.currentRequestId) {
      throw new Error("No active chat stream - cannot send request context result");
    }

    debugLog("[DEBUG] Sending request context result for id:", id);

    const execClientMsg = buildExecClientMessageWithRequestContextResult(id, execId);
    const responseMsg = buildAgentClientMessageWithExec(execClientMsg);

    await this.sendActiveClientMessage(responseMsg);

    // Send stream close control message
    const controlMsg = buildExecClientControlMessage(id);
    const controlResponseMsg = buildAgentClientMessageWithExecControl(controlMsg);

    await this.sendActiveClientMessage(controlResponseMsg);

    debugLog("[DEBUG] Stream close sent for exec id:", id);
  }

  /**
   * Send a file read result back to the server
   */
  async sendReadResult(
    id: number,
    execId: string | undefined,
    content: string,
    path: string,
    totalLines?: number,
    fileSize?: bigint,
    truncated?: boolean
  ): Promise<void> {
    if (!this.currentRequestId) {
      throw new Error("No active chat stream - cannot send read result");
    }

    debugLog("[DEBUG] Sending read result for id:", id, "path:", path, "contentLength:", content.length);

    const execClientMsg = buildExecClientMessageWithReadResult(id, execId, content, path, totalLines, fileSize, truncated);
    const responseMsg = buildAgentClientMessageWithExec(execClientMsg);

    await this.sendActiveClientMessage(responseMsg);

    // Send stream close control message
    const controlMsg = buildExecClientControlMessage(id);
    const controlResponseMsg = buildAgentClientMessageWithExecControl(controlMsg);

    await this.sendActiveClientMessage(controlResponseMsg);

    debugLog("[DEBUG] Stream close sent for exec id:", id);
  }

  /**
   * Send a grep/glob result back to the server
   */
  async sendGrepResult(
    id: number,
    execId: string | undefined,
    pattern: string,
    path: string,
    files: string[]
  ): Promise<void> {
    if (!this.currentRequestId) {
      throw new Error("No active chat stream - cannot send grep result");
    }

    debugLog("[DEBUG] Sending grep result for id:", id, "pattern:", pattern, "files:", files.length);

    const execClientMsg = buildExecClientMessageWithGrepResult(id, execId, pattern, path, files);
    const responseMsg = buildAgentClientMessageWithExec(execClientMsg);

    await this.sendActiveClientMessage(responseMsg);

    // Send stream close control message
    const controlMsg = buildExecClientControlMessage(id);
    const controlResponseMsg = buildAgentClientMessageWithExecControl(controlMsg);

    await this.sendActiveClientMessage(controlResponseMsg);

    debugLog("[DEBUG] Stream close sent for exec id:", id);
  }

  /**
   * Send a file write result back to the server
   */
  async sendWriteResult(
    id: number,
    execId: string | undefined,
    result: { 
      success?: { path: string; linesCreated: number; fileSize: number; fileContentAfterWrite?: string }; 
      error?: { path: string; error: string };
    }
  ): Promise<void> {
    if (!this.currentRequestId) {
      throw new Error("No active chat stream - cannot send write result");
    }

    debugLog("[DEBUG] Sending write result for id:", id, "result:", result.success ? "success" : "error");

    const execClientMsg = buildExecClientMessageWithWriteResult(id, execId, result);
    const responseMsg = buildAgentClientMessageWithExec(execClientMsg);

    await this.sendActiveClientMessage(responseMsg);

    // Send stream close control message
    const controlMsg = buildExecClientControlMessage(id);
    const controlResponseMsg = buildAgentClientMessageWithExecControl(controlMsg);

    await this.sendActiveClientMessage(controlResponseMsg);

    debugLog("[DEBUG] Stream close sent for exec id:", id);
  }

  /**
   * Send a ResumeAction for external conversation resumption.
   * Cursor CLI does not send this after controlled tool results; those resume by
   * streaming ExecClientMessage results followed by ExecClientControlMessage.streamClose.
   */
  async sendResumeAction(): Promise<void> {
    if (!this.currentRequestId) {
      throw new Error("No active chat stream - cannot send resume action");
    }

    debugLog("[DEBUG] sendResumeAction called:", {
      requestId: this.currentRequestId,
      currentSeqno: String(this.currentAppendSeqno),
    });

    // Cursor CLI populates ResumeAction.request_context (field 2), just like
    // UserMessageAction. Without it, the backend can accept tool results but end
    // the resumed turn without producing final text.
    const requestContext = buildRequestContext(this.workspacePath, this.currentTools, this.currentSystemPrompt);
    const conversationAction = encodeConversationActionWithResume(requestContext);
    const agentClientMessage = encodeAgentClientMessageWithConversationAction(conversationAction);

    debugLog("[DEBUG] Sending ResumeAction with bidiAppend...");
    await this.sendActiveClientMessage(agentClientMessage);

    debugLog("[DEBUG] ResumeAction sent successfully, new seqno:", String(this.currentAppendSeqno));
  }

  /**
   * Send a streaming chat request.
   *
   * Cursor periodically migrates AgentService/BidiService to different backends.
   * If a request fails before any meaningful output, retry against known agent
   * backends before surfacing the error.
   */
  async *chatStream(request: AgentChatRequest): AsyncGenerator<AgentStreamChunkType> {
    if (request.signal?.aborted) {
      yield { type: "error", error: "Cursor request aborted." };
      return;
    }
    const baseUrlAttempts = this.getBaseUrlAttempts();
    const maxTransportAttempts = Math.max(1, Number(process.env.PI_CURSOR_STREAM_RETRIES || 3));
    const maxResumeAttempts = process.env.PI_CURSOR_AGENT_RETRIES === "0" ? 0 : Math.max(0, Number(process.env.PI_CURSOR_AGENT_RETRIES || 3));
    let lastError: AgentStreamChunkType | null = null;
    let latestCheckpoint = request.checkpoint;
    let resumeAttempts = 0;
    let requestForAttempt: AgentChatRequest = request;
    // We stream chunks inline. Cursor's Resume action may replay text that we
    // already streamed before a mid-stream drop, so we trust the server's
    // conversation_checkpoint_update protocol: characters yielded before the
    // most recent checkpoint are "safe" (Resume promises to continue past
    // them); characters yielded after the most recent checkpoint sit in an
    // "unsafe window" that may be replayed. On Resume we dedup incoming text
    // against that unsafe window only — see decideAlignment below.
    let sawMeaningfulOutput = false;
    let yieldedText = "";
    let safeAnchor = 0;
    const yieldedToolCallIds = new Set<string>();
    let alignmentMode = false;
    let pendingAlignment = "";

    const flushAlignmentRemainder = (force: boolean): { type: "text"; content: string } | null => {
      const unsafe = yieldedText.slice(safeAnchor);
      const decision = decideAlignment(unsafe, pendingAlignment, force);
      if (!decision) return null;
      const remainder = pendingAlignment.slice(decision.skip);
      pendingAlignment = "";
      alignmentMode = false;
      if (!remainder) return null;
      yieldedText += remainder;
      return { type: "text", content: remainder };
    };

    for (let attemptIndex = 0; attemptIndex < baseUrlAttempts.length; attemptIndex++) {
      const baseUrl = baseUrlAttempts[attemptIndex] ?? this.baseUrl;
      this.baseUrl = baseUrl;

      for (let transportAttempt = 0; transportAttempt < maxTransportAttempts; transportAttempt++) {
        let retrySameBase = false;
        let retryNextBase = false;
        let retryResume = false;

        for await (const chunk of this.chatStreamOnce(requestForAttempt)) {
          if (chunk.type === "checkpoint" && chunk.checkpoint) {
            latestCheckpoint = chunk.checkpoint;
            yield chunk;
            // Anything yielded before this point is now checkpoint-protected.
            safeAnchor = yieldedText.length;
            continue;
          }

          if (chunk.type === "error") {
            lastError = chunk;
            const hasUnsafeText = yieldedText.length > safeAnchor;
            const canResumeWithoutOutput = !sawMeaningfulOutput;
            const canResumeAfterOutput = sawMeaningfulOutput && Boolean(latestCheckpoint);
            const canResume = !request.signal?.aborted
              && Boolean(latestCheckpoint)
              && resumeAttempts < maxResumeAttempts
              && this.shouldResumeAfterStreamError(chunk.error)
              && (canResumeWithoutOutput || canResumeAfterOutput);

            if (canResume) {
              resumeAttempts++;
              requestForAttempt = { ...request, action: "resume", checkpoint: latestCheckpoint };
              debugLog(`[DEBUG] chatStream resuming from checkpoint after stream error (attempt ${resumeAttempts}/${maxResumeAttempts}, hasUnsafeText=${hasUnsafeText}): ${chunk.error}`);
              await this.abortableDelay(500 * resumeAttempts, request.signal);
              // Enter alignment mode only when there is text in the unsafe
              // window — otherwise the next attempt's text is guaranteed-new.
              alignmentMode = hasUnsafeText;
              pendingAlignment = "";
              retryResume = true;
              break;
            }

            if (!sawMeaningfulOutput) {
              if (this.isRetriableH2TransportError(chunk.error) && transportAttempt < maxTransportAttempts - 1) {
                const delayMs = 500 * (transportAttempt + 1);
                debugLog(`[DEBUG] chatStream retrying same baseUrl after transient transport error in ${delayMs}ms: ${chunk.error}`);
                await this.abortableDelay(delayMs, request.signal);
                retrySameBase = true;
                break;
              }
              if (attemptIndex < baseUrlAttempts.length - 1) {
                debugLog(`[DEBUG] chatStream retrying with next baseUrl after error: ${chunk.error}`);
                retryNextBase = true;
                break;
              }
            }

            // Surfacing the error — flush whatever alignment buffer we have
            // best-effort so the consumer sees the partial Resume output.
            if (alignmentMode && pendingAlignment) {
              const remainder = flushAlignmentRemainder(true);
              if (remainder) yield remainder;
            }
            yield chunk;
            return;
          }

          if (chunk.type === "text" && chunk.content) {
            if (alignmentMode) {
              pendingAlignment += chunk.content;
              const remainder = flushAlignmentRemainder(false);
              if (remainder) {
                sawMeaningfulOutput = true;
                yield remainder;
              }
              continue;
            }
            yieldedText += chunk.content;
            sawMeaningfulOutput = true;
            yield chunk;
            continue;
          }

          if ((chunk.type === "tool_call_started" || chunk.type === "tool_call_completed") && chunk.toolCall?.callId) {
            if (chunk.type === "tool_call_started") {
              if (yieldedToolCallIds.has(chunk.toolCall.callId)) continue;
              yieldedToolCallIds.add(chunk.toolCall.callId);
            }
            sawMeaningfulOutput = true;
            yield chunk;
            continue;
          }

          if (
            chunk.type === "exec_request" ||
            chunk.type === "partial_tool_call" ||
            chunk.type === "interaction_query" ||
            chunk.type === "kv_blob_assistant"
          ) {
            sawMeaningfulOutput = true;
          }

          yield chunk;

          if (chunk.type === "exec_request") {
            // Non-active callers return after the tool handoff and let pi's
            // normal context replay path continue the next turn. Active Cursor
            // runs must keep this generator open so the background pump keeps
            // the AgentService bridge alive while pi executes the tool; the
            // next pi turn submits the tool result over that same bridge.
            if (!requestForAttempt.keepStreamOpenOnExecRequest) return;
            continue;
          }

          if (chunk.type === "interaction_query") {
            // User-interaction handoff is not resumable through pi's tool-result
            // path yet, so close the current attempt just like before.
            return;
          }
        }

        if (alignmentMode && pendingAlignment) {
          // Stream ended mid-alignment (e.g. resume produced just a short
          // continuation). Commit with whatever overlap we have so the consumer
          // sees the final answer rather than waiting forever.
          const remainder = flushAlignmentRemainder(true);
          if (remainder) {
            sawMeaningfulOutput = true;
            yield remainder;
          }
        }

        if (retryResume) continue;
        if (retrySameBase) continue;
        if (retryNextBase) break;
        return;
      }
    }

    if (alignmentMode && pendingAlignment) {
      const remainder = flushAlignmentRemainder(true);
      if (remainder) yield remainder;
    }
    if (lastError) {
      yield lastError;
    } else {
      yield { type: "error", error: "Unknown error" };
    }
  }

  private async *chatStreamOnce(
    request: AgentChatRequest
  ): AsyncGenerator<AgentStreamChunkType> {
    if (this.shouldUseNativeH2Bidi()) {
      let sawMeaningfulOutput = false;
      for await (const chunk of this.chatStreamNativeH2Once(request)) {
        if (chunk.type === "error" && !sawMeaningfulOutput && this.isRetriableH2TransportError(chunk.error)) {
          debugLog(`[DEBUG] Native HTTP/2 failed before output; falling back to RunSSE/BidiAppend: ${chunk.error}`);
          yield* this.chatStreamSseOnce(request);
          return;
        }
        if (chunk.type !== "heartbeat" && chunk.type !== "usage" && chunk.type !== "checkpoint") {
          sawMeaningfulOutput = true;
        }
        yield chunk;
      }
      return;
    }
    yield* this.chatStreamSseOnce(request);
  }

  private isRetriableH2TransportError(error?: string): boolean {
    if (!error) return false;
    return /fetch failed|Client network socket disconnected|secure TLS connection|ERR_HTTP2|HTTP\/2|stream.*cancel|premature close|ECONNRESET|EPIPE|ENOTFOUND|ETIMEDOUT/i.test(error);
  }

  private abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error("Cursor request aborted."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      if (!signal) return;
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Cursor request aborted."));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private shouldResumeAfterStreamError(error?: string): boolean {
    if (!error) return false;
    return /Stream ended without turnEnded|connection likely dropped mid-stream|fetch failed|Client network socket disconnected|secure TLS connection|ERR_HTTP2|HTTP\/2|stream.*cancel|premature close|ECONNRESET|EPIPE|ETIMEDOUT/i.test(error);
  }

  private shouldUseNativeH2Bidi(): boolean {
    if (process.env.PI_CURSOR_H2_BIDI === "0") return false;
    return typeof (globalThis as { Bun?: unknown }).Bun === "undefined";
  }

  private async *chatStreamNativeH2Once(
    request: AgentChatRequest
  ): AsyncGenerator<AgentStreamChunkType> {
    const metrics = createTimingMetrics();
    const requestId = randomUUID();
    const messageBody = this.buildChatMessage(request);
    metrics.messageBuildMs = Date.now() - metrics.requestStart;

    const HEARTBEAT_IDLE_MS_PROGRESS = 120000;
    const HEARTBEAT_MAX_PROGRESS = 1000;
    const HEARTBEAT_IDLE_MS_NOPROGRESS = 180000;
    const HEARTBEAT_MAX_NOPROGRESS = 1000;
    let lastProgressAt = Date.now();
    let heartbeatSinceProgress = 0;
    let hasProgress = false;
    const markProgress = () => {
      heartbeatSinceProgress = 0;
      lastProgressAt = Date.now();
      hasProgress = true;
    };

    this.currentRequestId = requestId;
    this.currentAppendSeqno = 0n;
    this.appendChain = Promise.resolve();

    const h2Client = connectHttp2(this.baseUrl);
    h2Client.on("error", (error) => {
      debugLog("[DEBUG] HTTP/2 client session error:", error instanceof Error ? error.message : String(error));
    });
    const requestHeaders = this.getHeaders(requestId);
    // Cursor CLI's native HTTP/2 AgentService/Run transport does not use the
    // HTTP/1.1 RunSSE streaming hint; the bidi stream itself carries responses.
    delete requestHeaders["x-cursor-streaming"];

    const h2Stream = h2Client.request({
      ":method": "POST",
      ":path": "/agent.v1.AgentService/Run",
      ...requestHeaders,
    });
    h2Stream.on("error", (error) => {
      debugLog("[DEBUG] HTTP/2 stream error:", error instanceof Error ? error.message : String(error));
    });

    this.currentH2Stream = h2Stream;

    const responseHeadersPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      h2Stream.once("response", resolve);
      h2Stream.once("error", reject);
    });

    const timeout = setTimeout(() => h2Stream.close(), 120000);
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let closingForCleanup = false;
    const onAbort = () => {
      debugLog("[DEBUG] HTTP/2 Agent stream aborted by caller");
      try { h2Stream.close(); } catch {}
      try { h2Client.close(); } catch {}
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await this.writeH2ClientMessage(messageBody);
      metrics.firstBidiAppendMs = Date.now() - metrics.requestStart;

      heartbeatTimer = setInterval(() => {
        const heartbeat = encodeMessageField(7, new Uint8Array(0));
        void this.sendActiveClientMessage(heartbeat).catch((error) => {
          debugLog("[DEBUG] HTTP/2 client heartbeat failed:", error instanceof Error ? error.message : String(error));
        });
      }, 5000);

      const responseHeaders = await responseHeadersPromise;
      const status = Number(responseHeaders[":status"] ?? 0);
      metrics.sseConnectionMs = Date.now() - metrics.requestStart;

      debugLog(
        `[TIMING] HTTP/2 bidi request sent: build=${metrics.messageBuildMs}ms, append=${metrics.firstBidiAppendMs}ms, response=${metrics.sseConnectionMs}ms, status=${status}`
      );

      if (status < 200 || status >= 300) {
        yield { type: "error", error: `HTTP/2 AgentService/Run failed: HTTP ${status}` };
        return;
      }

      let buffer = new Uint8Array(8192);
      let bufferUsed = 0;
      let turnEnded = false;
      let firstContentLogged = false;
      let hasStreamedText = false;
      this.pendingAssistantBlobs = [];

      for await (const rawChunk of h2Stream as AsyncIterable<Uint8Array | Buffer>) {
        const value = rawChunk instanceof Uint8Array ? rawChunk : new Uint8Array(rawChunk);
        if (!firstContentLogged) {
          metrics.firstChunkMs = Date.now() - metrics.requestStart;
          debugLog(`[TIMING] First HTTP/2 chunk received in ${metrics.firstChunkMs}ms`);
          firstContentLogged = true;
        }

        const needed = bufferUsed + value.length;
        if (needed > buffer.length) {
          let newSize = buffer.length;
          while (newSize < needed) newSize *= 2;
          const grown = new Uint8Array(newSize);
          grown.set(buffer.subarray(0, bufferUsed));
          buffer = grown;
        }
        buffer.set(value, bufferUsed);
        bufferUsed += value.length;

        let offset = 0;
        while (offset + 5 <= bufferUsed) {
          const flags = buffer[offset] ?? 0;
          const length = ((buffer[offset + 1] ?? 0) << 24) | ((buffer[offset + 2] ?? 0) << 16) | ((buffer[offset + 3] ?? 0) << 8) | (buffer[offset + 4] ?? 0);
          if (offset + 5 + length > bufferUsed) break;

          const frameData = buffer.slice(offset + 5, offset + 5 + length);
          offset += 5 + length;

          if ((flags ?? 0) & 0x80) {
            const trailer = new TextDecoder().decode(frameData);
            debugLog("Received HTTP/2 trailer frame:", trailer.slice(0, 200));
            const meta = parseTrailerMetadata(trailer);
            const grpcStatus = Number(meta["grpc-status"] ?? "0");
            if (grpcStatus !== 0) {
              if (grpcStatus === 8) {
                if (request.model === "auto") debugLog("gRPC status 8 (usage limit) with model auto: suppressing error");
                else yield { type: "error", error: "You've hit your usage limit" };
              } else {
                const grpcMessage = meta["grpc-message"] ? decodeURIComponent(meta["grpc-message"]) : "Unknown gRPC error";
                const decodedDetails = meta["grpc-status-details-bin"] ? decodeGrpcStatusDetailsBin(meta["grpc-status-details-bin"]) : undefined;
                yield { type: "error", error: decodedDetails ? `${grpcMessage} (grpc-status ${grpcStatus}): ${decodedDetails}` : `${grpcMessage} (grpc-status ${grpcStatus})` };
              }
            }
            continue;
          }

          // Connect EndStreamResponse frame. The useful status is normally in
          // the stream/trailers; once seen after a completed turn we can stop.
          if ((flags ?? 0) & 0x02) {
            debugLog("Received HTTP/2 end-stream frame:", frameData.length, new TextDecoder().decode(frameData).slice(0, 200), Buffer.from(frameData).toString("hex").slice(0, 200));
            const endStreamError = parseConnectEndStreamError(frameData);
            if (endStreamError) {
              yield { type: "error", error: endStreamError };
              break;
            }
            if (turnEnded) break;
            continue;
          }

          metrics.chunkCount++;
          const serverMsgFields = parseProtoFields(frameData);
          debugLog("[DEBUG] HTTP/2 server message fields:", serverMsgFields.map(f => `field${f.fieldNumber}:${f.wireType}`).join(", "));

          for (const field of serverMsgFields) {
            try {
              if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
                const parsed = parseInteractionUpdate(field.value);
                if (parsed.text) {
                  if (metrics.firstTextMs === undefined) metrics.firstTextMs = Date.now() - metrics.requestStart;
                  metrics.textChunks++;
                  yield { type: "text", content: parsed.text };
                  hasStreamedText = true;
                  markProgress();
                }
                if (parsed.toolCallStarted) {
                  if (metrics.firstToolCallMs === undefined) metrics.firstToolCallMs = Date.now() - metrics.requestStart;
                  metrics.toolCalls++;
                  yield { type: "tool_call_started", toolCall: {
                    callId: parsed.toolCallStarted.callId,
                    modelCallId: parsed.toolCallStarted.modelCallId,
                    toolType: parsed.toolCallStarted.toolType,
                    name: parsed.toolCallStarted.name,
                    arguments: parsed.toolCallStarted.arguments,
                  } };
                  markProgress();
                }
                if (parsed.toolCallCompleted) {
                  yield { type: "tool_call_completed", toolCall: {
                    callId: parsed.toolCallCompleted.callId,
                    modelCallId: parsed.toolCallCompleted.modelCallId,
                    toolType: parsed.toolCallCompleted.toolType,
                    name: parsed.toolCallCompleted.name,
                    arguments: parsed.toolCallCompleted.arguments,
                  } };
                  markProgress();
                }
                if (parsed.partialToolCall) {
                  yield { type: "partial_tool_call", toolCall: {
                    callId: parsed.partialToolCall.callId,
                    modelCallId: undefined,
                    toolType: "partial",
                    name: "partial",
                    arguments: "",
                  }, partialArgs: parsed.partialToolCall.argsTextDelta };
                  markProgress();
                }
                if (parsed.usage) yield { type: "usage", usage: parsed.usage };
                if (parsed.isComplete) {
                  metrics.turnEndedMs = Date.now() - metrics.requestStart;
                  turnEnded = true;
                }
                if (parsed.isHeartbeat) {
                  metrics.heartbeats++;
                  heartbeatSinceProgress++;
                  const idleMs = Date.now() - lastProgressAt;
                  const idleLimit = hasProgress ? HEARTBEAT_IDLE_MS_PROGRESS : HEARTBEAT_IDLE_MS_NOPROGRESS;
                  const beatLimit = hasProgress ? HEARTBEAT_MAX_PROGRESS : HEARTBEAT_MAX_NOPROGRESS;
                  if (heartbeatSinceProgress >= beatLimit || idleMs >= idleLimit) {
                    console.warn(`[DEBUG] HTTP/2 heartbeat idle for ${idleMs}ms (${heartbeatSinceProgress} beats) - closing stream`);
                    turnEnded = true;
                  } else {
                    yield { type: "heartbeat" };
                  }
                }
              }

              if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
                yield { type: "checkpoint", checkpoint: field.value };
                markProgress();
              }

              if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
                const execRequest = parseExecServerMessage(field.value);
                if (execRequest) {
                  metrics.execRequests++;
                  yield { type: "exec_request", execRequest };
                  markProgress();
                }
              }

              if (field.fieldNumber === 4 && field.wireType === 2 && field.value instanceof Uint8Array) {
                metrics.kvMessages++;
                const kvMsg = parseKvServerMessage(field.value);
                await this.handleKvMessage(kvMsg);
              }

              if (field.fieldNumber === 5 && field.wireType === 2 && field.value instanceof Uint8Array) {
                yield { type: "exec_server_abort" };
                markProgress();
              }

              if (field.fieldNumber === 7 && field.wireType === 2 && field.value instanceof Uint8Array) {
                const queryFields = parseProtoFields(field.value);
                let queryId = 0;
                let queryType = "unknown";
                for (const qf of queryFields) {
                  if (qf.fieldNumber === 1 && qf.wireType === 0) queryId = Number(qf.value);
                  else if (qf.fieldNumber === 2 && qf.wireType === 2) queryType = "web_search";
                  else if (qf.fieldNumber === 3 && qf.wireType === 2) queryType = "ask_question";
                  else if (qf.fieldNumber === 4 && qf.wireType === 2) queryType = "switch_mode";
                  else if (qf.fieldNumber === 5 && qf.wireType === 2) queryType = "exa_search";
                  else if (qf.fieldNumber === 6 && qf.wireType === 2) queryType = "exa_fetch";
                }
                yield { type: "interaction_query", queryId, queryType };
                markProgress();
              }
            } catch (parseErr) {
              const error = parseErr instanceof Error ? parseErr : new Error(String(parseErr));
              if (this.isRetriableH2TransportError(error.message)) debugLog("Error parsing HTTP/2 field after transient transport failure:", field.fieldNumber, error.message);
              else console.error("Error parsing HTTP/2 field:", field.fieldNumber, error);
              yield { type: "error", error: `Parse error in field ${field.fieldNumber}: ${error.message}` };
            }
          }

          if (turnEnded) break;
        }

        if (offset > 0) {
          const remaining = bufferUsed - offset;
          if (remaining > 0) buffer.copyWithin(0, offset, bufferUsed);
          bufferUsed = remaining;
        }

        if (turnEnded) break;
      }

      if (turnEnded) {
        closingForCleanup = true;
        h2Stream.close();
        logTimingMetrics(metrics);
        if (!hasStreamedText && this.pendingAssistantBlobs.length > 0) {
          for (const blob of this.pendingAssistantBlobs) {
            yield { type: "kv_blob_assistant", blobContent: blob.content };
          }
        }
        yield { type: "done" };
      } else if (request.signal?.aborted) {
        yield { type: "error", error: "Cursor request aborted." };
      } else {
        yield { type: "error", error: "Stream ended without turnEnded — connection likely dropped mid-stream" };
      }
    } catch (err: unknown) {
      const error = err as Error & { code?: string; name?: string };
      if (request.signal?.aborted) {
        yield { type: "error", error: "Cursor request aborted." };
        return;
      }
      if (closingForCleanup && (error.code === "ERR_HTTP2_STREAM_CANCEL" || error.code === "ERR_STREAM_PREMATURE_CLOSE")) return;
      if (this.isRetriableH2TransportError(error.message)) debugLog("HTTP/2 Agent stream transient error:", error.name, error.message);
      else console.error("HTTP/2 Agent stream error:", error.name, error.message, (err as Error).stack);
      // If callers fall back to the HTTP/1.1 bridge, do not leave the failed
      // HTTP/2 stream installed as the active client-message target.
      try { h2Stream.close(); } catch {}
      try { h2Client.close(); } catch {}
      this.currentH2Stream = null;
      this.currentRequestId = null;
      yield { type: "error", error: error.message || String(err) };
    } finally {
      closingForCleanup = true;
      clearTimeout(timeout);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      this.currentH2Stream = null;
      this.currentRequestId = null;
      request.signal?.removeEventListener("abort", onAbort);
      try { h2Stream.close(); } catch {}
      try { h2Client.close(); } catch {}
    }
  }

  private async *chatStreamSseOnce(
    request: AgentChatRequest
  ): AsyncGenerator<AgentStreamChunkType> {
    const metrics = createTimingMetrics();
    const requestId = randomUUID();

    const messageBody = this.buildChatMessage(request);
    metrics.messageBuildMs = Date.now() - metrics.requestStart;

    let appendSeqno = 0n;
    // Heartbeats are frequent; be generous to avoid premature turn cuts
    const HEARTBEAT_IDLE_MS_PROGRESS = 120000; // 2 minutes idle after progress
    const HEARTBEAT_MAX_PROGRESS = 1000; // generous beat budget once progress observed
    const HEARTBEAT_IDLE_MS_NOPROGRESS = 180000; // 3 minutes before first progress
    const HEARTBEAT_MAX_NOPROGRESS = 1000;
    let lastProgressAt = Date.now();
    let heartbeatSinceProgress = 0;
    let hasProgress = false;
    const markProgress = () => {
      heartbeatSinceProgress = 0;
      lastProgressAt = Date.now();
      hasProgress = true;
    };

    // Store for tool result submission
    this.currentRequestId = requestId;
    this.currentAppendSeqno = 0n;
    this.appendChain = Promise.resolve();

    // Build BidiRequestId message for RunSSE
    const bidiRequestId = encodeBidiRequestId(requestId);
    const envelope = addConnectEnvelope(bidiRequestId);

    // Start the SSE stream
    const sseUrl = `${this.baseUrl}/agent.v1.AgentService/RunSSE`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let abortedForCleanup = false;
    const onAbort = () => {
      debugLog("[DEBUG] SSE Agent stream aborted by caller");
      controller.abort();
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const ssePromise = fetch(sseUrl, {
        method: "POST",
        headers: this.getHeaders(requestId),
        body: Buffer.from(envelope),
        signal: controller.signal,
      });
      // RunSSE is intentionally opened before BidiAppend, so attach a handler
      // immediately to avoid a transient connection failure becoming an
      // unhandled rejection before we await it below.
      ssePromise.catch(() => {});

      // Send initial message
      await this.bidiAppend(requestId, appendSeqno++, messageBody);
      metrics.firstBidiAppendMs = Date.now() - metrics.requestStart;
      this.currentAppendSeqno = appendSeqno;
      this.appendChain = Promise.resolve();

      heartbeatTimer = setInterval(() => {
        const heartbeat = encodeMessageField(7, new Uint8Array(0));
        void this.sendActiveClientMessage(heartbeat).catch((error) => {
          debugLog("[DEBUG] Client heartbeat failed:", error instanceof Error ? error.message : String(error));
        });
      }, 5000);

      const sseResponse = await ssePromise;
      metrics.sseConnectionMs = Date.now() - metrics.requestStart;

      debugLog(
        `[TIMING] Request sent: build=${metrics.messageBuildMs}ms, append=${metrics.firstBidiAppendMs}ms, response=${metrics.sseConnectionMs}ms`
      );

      if (!sseResponse.ok) {
        clearTimeout(timeout);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        const errorText = await sseResponse.text();
        yield { type: "error", error: `SSE stream failed: ${sseResponse.status} - ${errorText}` };
        return;
      }

      if (!sseResponse.body) {
        clearTimeout(timeout);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        yield { type: "error", error: "No response body from SSE stream" };
        return;
      }

      const reader = sseResponse.body.getReader();
      // Growing buffer: track used length separately to avoid O(n^2) copies
      let buffer = new Uint8Array(8192);
      let bufferUsed = 0;
      let turnEnded = false;
      let firstContentLogged = false;
      let hasStreamedText = false; // Track if we received any text via streaming
      
      // Clear any pending assistant blobs from previous requests
      this.pendingAssistantBlobs = [];

      try {
        while (!turnEnded) {
          const { done, value } = await reader.read();

          if (done) {
            yield { type: "error", error: request.signal?.aborted ? "Cursor request aborted." : "Stream ended without turnEnded — connection likely dropped mid-stream" };
            break;
          }

          if (!firstContentLogged) {
            metrics.firstChunkMs = Date.now() - metrics.requestStart;
            debugLog(`[TIMING] First chunk received in ${metrics.firstChunkMs}ms`);
            firstContentLogged = true;
          }

          // Append to growing buffer - double capacity when needed
          const needed = bufferUsed + value.length;
          if (needed > buffer.length) {
            let newSize = buffer.length;
            while (newSize < needed) newSize *= 2;
            const grown = new Uint8Array(newSize);
            grown.set(buffer.subarray(0, bufferUsed));
            buffer = grown;
          }
          buffer.set(value, bufferUsed);
          bufferUsed += value.length;

          // Parse frames
          let offset = 0;
          while (offset + 5 <= bufferUsed) {
            const flags = buffer[offset] ?? 0;
            const b1 = buffer[offset + 1] ?? 0;
            const b2 = buffer[offset + 2] ?? 0;
            const b3 = buffer[offset + 3] ?? 0;
            const b4 = buffer[offset + 4] ?? 0;
            const length = (b1 << 24) | (b2 << 16) | (b3 << 8) | b4;

            if (offset + 5 + length > bufferUsed) break;

            const frameData = buffer.slice(offset + 5, offset + 5 + length);
            offset += 5 + length;

            // Check for trailer frame
            if ((flags ?? 0) & 0x80) {
              const trailer = new TextDecoder().decode(frameData);
              debugLog("Received trailer frame:", trailer.slice(0, 200));
              const meta = parseTrailerMetadata(trailer);
              const grpcStatus = Number(meta["grpc-status"] ?? "0");

              if (grpcStatus !== 0) {
                if (grpcStatus === 8) {
                  // RESOURCE_EXHAUSTED / usage limit: user-friendly message, or suspend when model is "auto"
                  if (request.model === "auto") {
                    debugLog("gRPC status 8 (usage limit) with model auto: suppressing error");
                  } else {
                    yield { type: "error", error: "You've hit your usage limit" };
                  }
                } else {
                  const grpcMessage = meta["grpc-message"]
                    ? decodeURIComponent(meta["grpc-message"])
                    : "Unknown gRPC error";

                  const detailsBin = meta["grpc-status-details-bin"];
                  const decodedDetails = detailsBin
                    ? decodeGrpcStatusDetailsBin(detailsBin)
                    : undefined;

                  const fullError = decodedDetails
                    ? `${grpcMessage} (grpc-status ${grpcStatus}): ${decodedDetails}`
                    : `${grpcMessage} (grpc-status ${grpcStatus})`;

                  console.error("gRPC error:", fullError);
                  yield { type: "error", error: fullError };
                }
              }
              continue;
            }

            // Connect EndStreamResponse frame. It can carry JSON errors even
            // when HTTP status is 200.
            if ((flags ?? 0) & 0x02) {
              const endStreamError = parseConnectEndStreamError(frameData);
              if (endStreamError) {
                yield { type: "error", error: endStreamError };
                break;
              }
              continue;
            }

            // Parse AgentServerMessage
            metrics.chunkCount++;
            const serverMsgFields = parseProtoFields(frameData);
            debugLog("[DEBUG] Server message fields:", serverMsgFields.map(f => `field${f.fieldNumber}:${f.wireType}`).join(", "));

            for (const field of serverMsgFields) {
              try {
                // field 1 = interaction_update
                if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  debugLog("[DEBUG] Received interaction_update, length:", field.value.length);
                  const parsed = parseInteractionUpdate(field.value);

                  // Yield text content
                  if (parsed.text) {
                    if (metrics.firstTextMs === undefined) {
                      metrics.firstTextMs = Date.now() - metrics.requestStart;
                    }
                    metrics.textChunks++;
                    yield { type: "text", content: parsed.text };
                    hasStreamedText = true;
                    markProgress();
                  }

                  // Yield tool call started
                  if (parsed.toolCallStarted) {
                    if (metrics.firstToolCallMs === undefined) {
                      metrics.firstToolCallMs = Date.now() - metrics.requestStart;
                    }
                    metrics.toolCalls++;
                    yield {
                      type: "tool_call_started",
                      toolCall: {
                        callId: parsed.toolCallStarted.callId,
                        modelCallId: parsed.toolCallStarted.modelCallId,
                        toolType: parsed.toolCallStarted.toolType,
                        name: parsed.toolCallStarted.name,
                        arguments: parsed.toolCallStarted.arguments,
                      },
                    };
                    markProgress();
                  }

                  // Yield tool call completed
                  if (parsed.toolCallCompleted) {
                    yield {
                      type: "tool_call_completed",
                      toolCall: {
                        callId: parsed.toolCallCompleted.callId,
                        modelCallId: parsed.toolCallCompleted.modelCallId,
                        toolType: parsed.toolCallCompleted.toolType,
                        name: parsed.toolCallCompleted.name,
                        arguments: parsed.toolCallCompleted.arguments,
                      },
                    };
                    markProgress();
                  }

                  // Yield partial tool call updates
                  if (parsed.partialToolCall) {
                    yield {
                      type: "partial_tool_call",
                      toolCall: {
                        callId: parsed.partialToolCall.callId,
                        modelCallId: undefined,
                        toolType: "partial",
                        name: "partial",
                        arguments: "",
                      },
                      partialArgs: parsed.partialToolCall.argsTextDelta,
                    };
                    markProgress();
                  }

                  if (parsed.usage) {
                    yield { type: "usage", usage: parsed.usage };
                  }

                  if (parsed.isComplete) {
                    metrics.turnEndedMs = Date.now() - metrics.requestStart;
                    turnEnded = true;
                  }

                  // Yield heartbeat events for the server to track
                  if (parsed.isHeartbeat) {
                    metrics.heartbeats++;
                    heartbeatSinceProgress++;
                    const idleMs = Date.now() - lastProgressAt;
                    const idleLimit = hasProgress ? HEARTBEAT_IDLE_MS_PROGRESS : HEARTBEAT_IDLE_MS_NOPROGRESS;
                    const beatLimit = hasProgress ? HEARTBEAT_MAX_PROGRESS : HEARTBEAT_MAX_NOPROGRESS;
                    if (heartbeatSinceProgress >= beatLimit || idleMs >= idleLimit) {
                      console.warn(
                        `[DEBUG] Heartbeat idle for ${idleMs}ms (${heartbeatSinceProgress} beats) - closing stream`
                      );
                      turnEnded = true;
                    } else {
                      yield { type: "heartbeat" };
                    }
                  }
                }

                // field 3 = conversation_checkpoint_update (completion signal)
                // NOTE: Checkpoint does NOT mean we're done! exec_server_message can come AFTER checkpoint.
                // Only end on turn_ended (field 14 in interaction_update) or stream close.
                if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  debugLog("[DEBUG] Received checkpoint, data length:", field.value.length);
                  // Try to parse checkpoint to see what it contains
                  const checkpointFields = parseProtoFields(field.value);
                  debugLog("[DEBUG] Checkpoint fields:", checkpointFields.map(f => `field${f.fieldNumber}:${f.wireType}`).join(", "));
                  for (const cf of checkpointFields) {
                    if (cf.wireType === 2 && cf.value instanceof Uint8Array) {
                      try {
                        const text = new TextDecoder().decode(cf.value);
                        if (text.length < 200) {
                          debugLog(`[DEBUG] Checkpoint field ${cf.fieldNumber}: ${text}`);
                        }
                      } catch {}
                    }
                  }
                  yield { type: "checkpoint", checkpoint: field.value };
                  markProgress();
                }

                // field 2 = exec_server_message (tool execution request)
                if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  debugLog("[DEBUG] Received exec_server_message (field 2), length:", field.value.length);

                  // Parse the ExecServerMessage
                  const execRequest = parseExecServerMessage(field.value);

                  if (execRequest) {
                    // Log based on type
                    if (execRequest.type === 'mcp') {
                      debugLog("[DEBUG] Parsed MCP exec request:", {
                        id: execRequest.id,
                        name: execRequest.name,
                        toolName: execRequest.toolName,
                        providerIdentifier: execRequest.providerIdentifier,
                        toolCallId: execRequest.toolCallId,
                        args: execRequest.args,
                      });
                    } else {
                      debugLog(`[DEBUG] Parsed ${execRequest.type} exec request:`, execRequest);
                    }

                    // Yield exec_request chunk for the server to handle
                    metrics.execRequests++;
                    yield {
                      type: "exec_request",
                      execRequest,
                    };
                    markProgress();
                  } else {
                    // Log other exec types we don't handle yet
                    const execFields = parseProtoFields(field.value);
                    debugLog("[DEBUG] exec_server_message fields (unhandled):", execFields.map(f => `field${f.fieldNumber}`).join(", "));
                  }
                }

                // field 4 = kv_server_message
                if (field.fieldNumber === 4 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  metrics.kvMessages++;
                  const kvMsg = parseKvServerMessage(field.value);
                  debugLog(`[DEBUG] KV message: id=${kvMsg.id}, type=${kvMsg.messageType}, blobId=${kvMsg.blobId ? Buffer.from(kvMsg.blobId).toString('hex').slice(0, 20) : 'none'}...`);
                  await this.handleKvMessage(kvMsg);
                }

                // field 5 = exec_server_control_message (abort signal from server)
                if (field.fieldNumber === 5 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  debugLog("[DEBUG] Received exec_server_control_message (field 5)!");
                  const controlFields = parseProtoFields(field.value);
                  debugLog("[DEBUG] exec_server_control_message fields:", controlFields.map(f => `field${f.fieldNumber}:${f.wireType}`).join(", "));
                  
                  // ExecServerControlMessage has field 1 = abort (ExecServerAbort)
                  for (const cf of controlFields) {
                    if (cf.fieldNumber === 1 && cf.wireType === 2 && cf.value instanceof Uint8Array) {
                      debugLog("[DEBUG] Server sent abort signal!");
                      // Parse ExecServerAbort - it has field 1 = id (string)
                      const abortFields = parseProtoFields(cf.value);
                      for (const af of abortFields) {
                        if (af.fieldNumber === 1 && af.wireType === 2 && af.value instanceof Uint8Array) {
                          const abortId = new TextDecoder().decode(af.value);
                          debugLog("[DEBUG] Abort id:", abortId);
                        }
                      }
                      yield { type: "exec_server_abort" };
                    }
                  }
                  markProgress();
                }

                // field 7 = interaction_query (server asking for user approval/input)
                if (field.fieldNumber === 7 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  debugLog("[DEBUG] Received interaction_query (field 7)!");
                  const queryFields = parseProtoFields(field.value);
                  debugLog("[DEBUG] interaction_query fields:", queryFields.map(f => `field${f.fieldNumber}:${f.wireType}`).join(", "));
                  
                  // InteractionQuery structure:
                  // field 1 = id (uint32)
                  // field 2 = web_search_request_query (oneof)
                  // field 3 = ask_question_interaction_query (oneof)
                  // field 4 = switch_mode_request_query (oneof)
                  // field 5 = exa_search_request_query (oneof)
                  // field 6 = exa_fetch_request_query (oneof)
                  let queryId = 0;
                  let queryType = 'unknown';
                  
                  for (const qf of queryFields) {
                    if (qf.fieldNumber === 1 && qf.wireType === 0) {
                      queryId = Number(qf.value);
                    } else if (qf.fieldNumber === 2 && qf.wireType === 2) {
                      queryType = 'web_search';
                    } else if (qf.fieldNumber === 3 && qf.wireType === 2) {
                      queryType = 'ask_question';
                    } else if (qf.fieldNumber === 4 && qf.wireType === 2) {
                      queryType = 'switch_mode';
                    } else if (qf.fieldNumber === 5 && qf.wireType === 2) {
                      queryType = 'exa_search';
                    } else if (qf.fieldNumber === 6 && qf.wireType === 2) {
                      queryType = 'exa_fetch';
                    }
                  }
                  
                  debugLog(`[DEBUG] InteractionQuery: id=${queryId}, type=${queryType}`);
                  
                  // Yield the interaction query for the server to handle
                  yield {
                    type: "interaction_query",
                    queryId,
                    queryType,
                  };
                  markProgress();
                }
              } catch (parseErr) {
                const error = parseErr instanceof Error ? parseErr : new Error(String(parseErr));
                if (this.isRetriableH2TransportError(error.message)) debugLog("Error parsing field after transient transport failure:", field.fieldNumber, error.message);
                else console.error("Error parsing field:", field.fieldNumber, error);
                yield { type: "error", error: `Parse error in field ${field.fieldNumber}: ${error.message}` };
              }
            }

            if (turnEnded) {
              break;
            }
          }

          // Compact: shift unconsumed bytes to front instead of allocating new array
          if (offset > 0) {
            const remaining = bufferUsed - offset;
            if (remaining > 0) {
              buffer.copyWithin(0, offset, bufferUsed);
            }
            bufferUsed = remaining;
          }
        }

        // Clean exit - check for KV blob assistant responses if no text was streamed
        if (turnEnded) {
          controller.abort(); // Clean up the connection
          logTimingMetrics(metrics);
          
          // Session reuse: If no text was streamed but we have pending assistant blobs,
          // emit them as kv_blob_assistant chunks so the server can use the content
          if (!hasStreamedText && this.pendingAssistantBlobs.length > 0) {
            debugLog(`[DEBUG] No streamed text but found ${this.pendingAssistantBlobs.length} assistant blob(s) - emitting`);
            for (const blob of this.pendingAssistantBlobs) {
              yield { type: "kv_blob_assistant", blobContent: blob.content };
            }
          }
          
          yield { type: "done" };
        }
      } finally {
        abortedForCleanup = true;
        controller.abort();
        reader.releaseLock();
        clearTimeout(timeout);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        request.signal?.removeEventListener("abort", onAbort);
        this.currentRequestId = null;
      }
    } catch (err: unknown) {
      clearTimeout(timeout);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      request.signal?.removeEventListener("abort", onAbort);
      this.currentRequestId = null;
      const error = err as Error & { name?: string };
      if (request.signal?.aborted) {
        yield { type: "error", error: "Cursor request aborted." };
        return;
      }
      if (error.name === 'AbortError' || abortedForCleanup) {
        // Normal termination after turn ended or after the caller stopped early for a pi tool call.
        return;
      }
      if (this.isRetriableH2TransportError(error.message)) debugLog("Agent stream transient error:", error.name, error.message);
      else console.error("Agent stream error:", error.name, error.message, (err as Error).stack);
      yield { type: "error", error: error.message || String(err) };
    }
  }

  /**
   * Fetch the Cursor models available to the authenticated subscription.
   */
  async getUsableModels(): Promise<Array<{ id: string; name: string; reasoning: boolean; contextWindow: number; maxTokens: number }>> {
    let lastError: Error | undefined;

    for (const baseUrl of this.getBaseUrlAttempts()) {
      this.baseUrl = baseUrl;
      try {
        const bytes = await this.callUnaryProtoH2(baseUrl, "/agent.v1.AgentService/GetUsableModels", new Uint8Array(0));
        const payloads = this.decodeGrpcWebDataFrames(bytes);
        const models = payloads.flatMap((payload) => this.parseGetUsableModelsResponse(payload));
        const unique = new Map<string, { id: string; name: string; reasoning: boolean; contextWindow: number; maxTokens: number }>();
        for (const model of models) unique.set(model.id, model);
        return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if (lastError) throw lastError;
    return [];
  }

  private callUnaryProtoH2(baseUrl: string, path: string, body: Uint8Array): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const client = connectHttp2(baseUrl);
      const chunks: Buffer[] = [];
      let status = 0;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        client.close();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const timeout = setTimeout(() => fail(new Error(`Cursor unary RPC timed out: ${path}`)), 15000);

      client.on("error", (error) => fail(error));
      const stream = client.request({
        ":method": "POST",
        ":path": path,
        "content-type": "application/proto",
        "connect-protocol-version": "1",
        "te": "trailers",
        "authorization": `Bearer ${this.accessToken}`,
        "user-agent": "connect-es/1.6.1",
        "x-ghost-mode": "true",
        "x-cursor-client-version": this.clientVersionHeader,
        "x-cursor-client-type": "cli",
        "x-request-id": randomUUID(),
      });
      stream.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
      });
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on("error", (error) => fail(error));
      stream.on("end", () => {
        if (settled) return;
        settled = true;
        cleanup();
        const bytes = Buffer.concat(chunks);
        if (status < 200 || status >= 300) {
          reject(new Error(`Cursor unary RPC failed: HTTP ${status}`));
          return;
        }
        resolve(new Uint8Array(bytes));
      });
      stream.end(Buffer.from(body));
    });
  }

  private decodeGrpcWebDataFrames(bytes: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    let offset = 0;
    while (offset + 5 <= bytes.length) {
      const flags = bytes[offset] ?? 0;
      const length = ((bytes[offset + 1] ?? 0) << 24) | ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0);
      const frameEnd = offset + 5 + length;
      if (frameEnd > bytes.length) break;
      if ((flags & 0x80) === 0 && length > 0) frames.push(bytes.slice(offset + 5, frameEnd));
      offset = frameEnd;
    }
    return frames.length > 0 ? frames : bytes.length > 0 ? [bytes] : [];
  }

  private parseGetUsableModelsResponse(payload: Uint8Array): Array<{ id: string; name: string; reasoning: boolean; contextWindow: number; maxTokens: number }> {
    const models: Array<{ id: string; name: string; reasoning: boolean; contextWindow: number; maxTokens: number }> = [];
    for (const field of parseProtoFields(payload)) {
      if (field.fieldNumber !== 1 || field.wireType !== 2 || !(field.value instanceof Uint8Array)) continue;
      const model = this.parseModelDetails(field.value);
      if (model) models.push(model);
    }
    return models;
  }

  private parseModelDetails(payload: Uint8Array): { id: string; name: string; reasoning: boolean; contextWindow: number; maxTokens: number } | null {
    const decoder = new TextDecoder();
    let id = "";
    let displayModelId = "";
    let displayName = "";
    let displayNameShort = "";
    const aliases: string[] = [];
    let reasoning = false;

    for (const field of parseProtoFields(payload)) {
      if (field.wireType === 2 && field.value instanceof Uint8Array) {
        if (field.fieldNumber === 1) id = decoder.decode(field.value).trim();
        else if (field.fieldNumber === 2) reasoning = true;
        else if (field.fieldNumber === 3) displayModelId = decoder.decode(field.value).trim();
        else if (field.fieldNumber === 4) displayName = decoder.decode(field.value).trim();
        else if (field.fieldNumber === 5) displayNameShort = decoder.decode(field.value).trim();
        else if (field.fieldNumber === 6) {
          const alias = decoder.decode(field.value).trim();
          if (alias) aliases.push(alias);
        }
      }
    }

    if (!id) return null;
    const name = displayName || displayNameShort || displayModelId || aliases[0] || id;
    return { id, name, reasoning, ...this.estimateModelLimits(id) };
  }

  private estimateModelLimits(id: string): { contextWindow: number; maxTokens: number } {
    const normalized = id.toLowerCase();
    if (normalized.includes("@1m") || normalized.includes("1m") || normalized.includes("gemini-3.1")) return { contextWindow: 1_000_000, maxTokens: 64_000 };
    if (normalized.includes("codex") || normalized.includes("gpt")) return { contextWindow: 272_000, maxTokens: 128_000 };
    return { contextWindow: 200_000, maxTokens: 64_000 };
  }

  /**
   * Send a non-streaming chat request (collects all chunks)
   */
  async chat(request: AgentChatRequest): Promise<string> {
    let result = "";

    for await (const chunk of this.chatStream(request)) {
      if (chunk.type === "error") {
        throw new Error(chunk.error ?? "Unknown error");
      }
      if (chunk.type === "text" && chunk.content) {
        result += chunk.content;
      }
    }

    return result;
  }
}

/**
 * Create an Agent Service client
 */
export function createAgentServiceClient(
  accessToken: string,
  options?: AgentServiceOptions
): AgentServiceClient {
  return new AgentServiceClient(accessToken, options);
}
