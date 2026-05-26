// @ts-nocheck
export {
  encodeVarint,
  encodeStringField,
  encodeUint32Field,
  encodeInt32Field,
  encodeInt64Field,
  encodeMessageField,
  encodeBoolField,
  encodeDoubleField,
  concatBytes,
  encodeProtobufValue,
  hexDump,
} from "./encoding.js";

export {
  decodeVarint,
  parseProtoFields,
  parseProtobufValue,
  parseProtobufStruct,
  parseProtobufListValue,
} from "./decoding.js";

export type { ParsedField } from "./decoding.js";

export {
  AgentMode,
} from "./types.js";

export type {
  OpenAIToolDefinition,
  McpExecRequest,
  ShellExecRequest,
  LsExecRequest,
  ReadExecRequest,
  GrepExecRequest,
  WriteExecRequest,
  ExecRequest,
  KvServerMessage,
  ToolCallInfo,
  ParsedToolCall,
  ParsedToolCallStarted,
  ParsedPartialToolCall,
  AgentStreamChunk,
  ChatTimingMetrics,
  AgentServiceOptions,
  AgentChatRequest,
  McpResult,
  ShellOutcome,
  WriteResult,
  BlobAnalysis,
  ParsedInteractionUpdate,
} from "./types.js";

export {
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
} from "./exec.js";

export {
  TOOL_FIELD_MAP,
  TOOL_ARG_SCHEMA,
  parseToolCall,
  parseToolCallStartedUpdate,
  parsePartialToolCallUpdate,
} from "./tool-calls.js";

export {
  parseKvServerMessage,
  buildKvClientMessage,
  buildAgentClientMessageWithKv,
  analyzeBlobData,
  extractAssistantContent,
} from "./kv.js";

export type { AssistantBlobContent } from "./kv.js";

export {
  encodeBidiRequestId,
  encodeBidiAppendRequest,
} from "./bidi.js";

export {
  encodeMcpToolDefinition,
  buildRequestContextEnv,
  encodeMcpInstructions,
  encodeCursorRule,
  buildRequestContext,
  encodeUserMessage,
  encodeUserMessageAction,
  encodeConversationAction,
  encodeResumeAction,
  encodeConversationActionWithResume,
  encodeAgentClientMessageWithConversationAction,
  encodeModelDetails,
  encodeRequestedModel,
  encodeEmptyConversationState,
  encodeMcpTools,
  encodeMcpDescriptor,
  encodeMcpFileSystemOptions,
  encodeAgentRunRequest,
  encodeAgentClientMessage,
} from "./agent-messages.js";

export type { McpDescriptorInput } from "./agent-messages.js";

export { parseInteractionUpdate } from "./interaction.js";
