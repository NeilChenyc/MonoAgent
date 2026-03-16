/**
 * MonoAgent Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Agent, type AgentEvent, type AgentMessage } from '@mariozechner/pi-agent-core';
import { complete, type Message } from '@mariozechner/pi-ai';
import { Type } from '@sinclair/typebox';
import { BashSession, type BashResult } from './tools/bash-session.js';
import { readFileTool, writeFileTool } from './tools/file-tools.js';
import { truncateTail } from './tools/truncate.js';
import { createIpcTools } from './tools/monoagent-tools.js';
import { getRouteById, loadModelsConfig, resolveModel, selectRoute } from './models.js';
import { loadSkillsManifest } from './skills.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---MONOAGENT_OUTPUT_START---';
const OUTPUT_END_MARKER = '---MONOAGENT_OUTPUT_END---';
const MAX_TOOL_RESULT_BYTES = 8 * 1024;

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
          type?: string;
          text?: string;
        };
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${String(err)}`);
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function loadSessionMessages(sessionPath: string): AgentMessage[] {
  if (!fs.existsSync(sessionPath)) return [];
  const lines = fs.readFileSync(sessionPath, 'utf-8').split('\n').filter(Boolean);
  const messages: AgentMessage[] = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line) as AgentMessage);
    } catch {
      /* ignore */
    }
  }
  return messages;
}

function appendSessionMessages(sessionPath: string, messages: AgentMessage[]): void {
  if (messages.length === 0) return;
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const data = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
  fs.appendFileSync(sessionPath, data, 'utf-8');
}

function extractAssistantText(message: Message | AgentMessage | null): string {
  if (!message || typeof message !== 'object') return '';
  // pi-ai AssistantMessage
  const content = (message as Message).content as Array<{ type: string; text?: string }> | undefined;
  if (!content) return '';
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('');
}

function truncateToolResult(messages: AgentMessage[]): AgentMessage[] {
  try {
    return messages.map((msg) => {
      if (msg.role !== 'toolResult' || !Array.isArray((msg as any).content)) {
        return msg;
      }
      const contentBlocks = (msg as any).content as Array<{ type: string; text?: string }>;
      const text = contentBlocks
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('');
      if (!text || Buffer.byteLength(text, 'utf-8') <= MAX_TOOL_RESULT_BYTES) {
        return msg;
      }
      const truncated = truncateTail(text, { maxBytes: MAX_TOOL_RESULT_BYTES });
      return {
        ...msg,
        content: [
          {
            type: 'text',
            text: `${truncated.content}\n[Tool output truncated in context]`,
          },
        ],
      } as AgentMessage;
    });
  } catch {
    return messages;
  }
}

function classifyError(output: string): { type: string; hint: string } {
  const rules: Array<{ pattern: RegExp; type: string; hint: string }> = [
    { pattern: /command not found/i, type: 'command_not_found', hint: 'Check command spelling or install missing dependencies.' },
    { pattern: /no such file or directory/i, type: 'missing_file', hint: 'Check that the path exists and is accessible.' },
    { pattern: /permission denied/i, type: 'permission_denied', hint: 'Check permissions or use a writable directory.' },
    { pattern: /module not found/i, type: 'missing_module', hint: 'Check that dependencies are installed.' },
    { pattern: /npm ERR!/i, type: 'npm_error', hint: 'Review npm logs and resolve dependency versions.' },
    { pattern: /pip.*not found/i, type: 'pip_missing', hint: 'Check that pip is installed.' },
  ];
  for (const rule of rules) {
    if (rule.pattern.test(output)) return { type: rule.type, hint: rule.hint };
  }
  return { type: 'unknown', hint: 'Read the error output and attempt a fix.' };
}

function detectModelHint(prompt: string): string | undefined {
  const lowered = prompt.toLowerCase();
  if (prompt.includes('```') || /\b(code|bug|error|stack|trace|compile|build)\b/.test(lowered)) {
    return 'code';
  }
  return 'general';
}

async function autoExtractMemory(
  model: ReturnType<typeof resolveModel>,
  conversation: string,
  writeMemory: (item: { content: string; summary?: string; tags?: string[]; source?: string }) => void,
): Promise<void> {
  const prompt = `Extract up to 3 decision points or key conclusions from the conversation below. Return a JSON array with fields: content (required), summary (optional), tags (optional array), source (optional). If none, return an empty array.\n\nConversation:\n${conversation}`;
  try {
    const response = await complete(model, {
      messages: [{ role: 'user', content: prompt }],
    });
    const text = extractAssistantText(response);
    const jsonStart = text.indexOf('[');
    const jsonEnd = text.lastIndexOf(']');
    if (jsonStart === -1 || jsonEnd === -1) return;
    const items = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Array<{
      content: string;
      summary?: string;
      tags?: string[];
      source?: string;
    }>;
    for (const item of items) {
      if (item?.content) writeMemory(item);
    }
  } catch (err) {
    log(`Memory extraction failed: ${String(err)}`);
  }
}

async function run(): Promise<void> {
  let input: ContainerInput;
  try {
    const stdinData = await readStdin();
    input = JSON.parse(stdinData) as ContainerInput;
  } catch (err) {
    writeOutput({ status: 'error', result: null, error: `Failed to parse input: ${String(err)}` });
    process.exit(1);
    return;
  }

  const sessionId = input.sessionId || `session-${crypto.randomBytes(6).toString('hex')}`;
  const sessionPath = path.join('/workspace/group', '.monoagent', sessionId, 'session.jsonl');
  const modelsConfig = loadModelsConfig();

  const bashSession = new BashSession();
  const ipcTools = createIpcTools({
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isMain: input.isMain,
  });

  const bashTool = {
    name: 'bash',
    label: 'Bash',
    description: 'Run shell commands in a sandboxed environment.',
    parameters: Type.Object({ command: Type.String() }),
    execute: async (_toolCallId: string, params: { command: string }, signal?: AbortSignal, onUpdate?: (partial: any) => void) => {
      const result = await bashSession.exec(params.command, {
        signal,
        onChunk: (chunk) => {
          onUpdate?.({
            content: [{ type: 'text', text: chunk }],
            details: { streaming: true },
          });
        },
      });
      let outputText = result.output || '';
      if (result.truncated && result.fullOutputPath) {
        outputText += `\n\n[Output truncated. Full output: ${result.fullOutputPath}]`;
      }
      return {
        content: [{ type: 'text', text: outputText || '(no output)' }],
        details: result,
      };
    },
  };

  const readFullOutputTool = {
    name: 'read_full_output',
    label: 'Read Full Output',
    description: 'Read output from a truncated bash command (full by default, optional tail truncation).',
    parameters: Type.Object({
      path: Type.String(),
      maxBytes: Type.Optional(Type.Integer({ minimum: 1 })),
      maxLines: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    execute: async (_toolCallId: string, params: { path: string; maxBytes?: number; maxLines?: number }) => {
      const content = fs.readFileSync(params.path, 'utf-8');
      if (params.maxBytes || params.maxLines) {
        const truncated = truncateTail(content, {
          maxBytes: params.maxBytes,
          maxLines: params.maxLines,
        });
        return {
          content: [{ type: 'text', text: truncated.content }],
          details: { truncated: truncated.truncated },
        };
      }
      return {
        content: [{ type: 'text', text: content }],
        details: { truncated: false },
      };
    },
  };

  const tools = [bashTool, readFileTool, writeFileTool, readFullOutputTool, ...ipcTools];
  const skillState = loadSkillsManifest();
  const filteredTools = tools.filter((tool) => {
    if (skillState.enabledTools && !skillState.enabledTools.has(tool.name)) return false;
    if (skillState.disabledTools.has(tool.name)) return false;
    return true;
  });
  const systemPrompt = [
    'You are MonoAgent, a lightweight autonomous agent.',
    ...skillState.systemPrompts,
  ]
    .filter(Boolean)
    .join('\n\n');

  let recoveryUsed = false;
  let recoveryPending: { toolName: string; output: string } | null = null;

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: resolveModel(selectRoute(modelsConfig)),
      tools: filteredTools,
      messages: loadSessionMessages(sessionPath),
    },
    sessionId,
    convertToLlm: (messages) => messages.filter((m) => {
      return (m as Message).role === 'user' || (m as Message).role === 'assistant' || (m as Message).role === 'toolResult';
    }) as Message[],
    transformContext: async (messages) => truncateToolResult(messages),
    afterToolCall: async ({ toolCall, result }) => {
      if (toolCall.name === 'bash') {
        const details = result.details as BashResult | undefined;
        if (details && details.exitCode && details.exitCode !== 0) {
          const output = extractAssistantText({ content: result.content } as Message);
          recoveryPending = { toolName: 'bash', output };
          return { isError: true };
        }
        if (details?.cancelled) {
          recoveryPending = { toolName: 'bash', output: 'Command cancelled.' };
          return { isError: true };
        }
      }
      return undefined;
    },
    getFollowUpMessages: async () => {
      if (!recoveryPending || recoveryUsed) return [];
      recoveryUsed = true;
      const classification = classifyError(recoveryPending.output || '');
      const msg: AgentMessage = {
        role: 'user',
        content: `Tool failed (${classification.type}): ${classification.hint}\nOutput:\n${recoveryPending.output}\nAnalyze and attempt a fix. Only try once.`,
        timestamp: Date.now(),
      } as any;
      recoveryPending = null;
      return [msg];
    },
  });

  const sessionMessages: AgentMessage[] = [];
  agent.subscribe((event: AgentEvent) => {
    if (event.type === 'message_end') {
      sessionMessages.push(event.message);
    }
  });

  const runTurn = async (promptText: string) => {
    const hint = detectModelHint(promptText);
    const primaryRoute = selectRoute(modelsConfig, hint);
    const routeChain = [primaryRoute.id, ...(primaryRoute.fallback || [])];
    let message: AgentMessage | Message | null = null;
    let lastError: unknown = null;

    for (const routeId of routeChain) {
      const route = routeId === primaryRoute.id
        ? primaryRoute
        : getRouteById(modelsConfig, routeId);
      if (!route) continue;
      agent.setModel(resolveModel(route));
      try {
        message = await agent.prompt({
          role: 'user',
          content: promptText,
          timestamp: Date.now(),
        } as any);
        break;
      } catch (err) {
        lastError = err;
        log(`Model route ${route.id} failed: ${String(err)}`);
      }
    }

    if (!message) {
      throw lastError || new Error('All model routes failed');
    }

    appendSessionMessages(sessionPath, sessionMessages.splice(0));

    const text = extractAssistantText(message as Message);
    writeOutput({ status: 'success', result: text || null, newSessionId: sessionId });

    await autoExtractMemory(
      agent.state.model,
      promptText + '\n' + text,
      (item) => {
        const memoryDir = '/workspace/ipc/memory';
        fs.mkdirSync(memoryDir, { recursive: true });
        const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
        fs.writeFileSync(
          path.join(memoryDir, filename),
          JSON.stringify({ type: 'write_memory', ...item }, null, 2),
        );
      },
    );
  };

  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK]\n\n${prompt}`;
  }

  const pending = drainIpcInput();
  if (pending.length > 0) {
    prompt += `\n${pending.join('\n')}`;
  }

  try {
    while (true) {
      await runTurn(prompt);
      if (shouldClose()) break;
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) break;
      prompt = nextMessage;
    }
  } catch (err) {
    writeOutput({ status: 'error', result: null, newSessionId: sessionId, error: String(err) });
    process.exit(1);
  }
}

run().catch((err) => {
  writeOutput({ status: 'error', result: null, error: String(err) });
  process.exit(1);
});
