import fs from 'fs';
import path from 'path';
import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { truncateHead } from './truncate.js';

const WORKSPACE_ROOT = '/workspace';

function resolveSafePath(inputPath: string): string {
  const resolved = path.resolve(WORKSPACE_ROOT, inputPath.replace(/^\/+/, ''));
  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    throw new Error('Path must stay under /workspace sandbox');
  }
  return resolved;
}

export const readFileTool: AgentTool = {
  name: 'read_file',
  label: 'Read File',
  description: 'Read a file from /workspace (truncated).',
  parameters: Type.Object({
    path: Type.String(),
    maxBytes: Type.Optional(Type.Integer({ minimum: 1 })),
    maxLines: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
  execute: async (_toolCallId, params) => {
    const fullPath = resolveSafePath(params.path);
    const content = fs.readFileSync(fullPath, 'utf-8');
    const truncated = truncateHead(content, {
      maxBytes: params.maxBytes,
      maxLines: params.maxLines,
    });
    return {
      content: [{ type: 'text', text: truncated.content }],
      details: {
        path: fullPath,
        truncated: truncated.truncated,
        totalBytes: truncated.totalBytes,
        totalLines: truncated.totalLines,
      },
    };
  },
};

export const writeFileTool: AgentTool = {
  name: 'write_file',
  label: 'Write File',
  description: 'Write a file under /workspace/group.',
  parameters: Type.Object({
    path: Type.String(),
    content: Type.String(),
  }),
  execute: async (_toolCallId, params) => {
    const fullPath = resolveSafePath(params.path);
    if (!fullPath.startsWith('/workspace/group')) {
      throw new Error('Write only allowed under /workspace/group');
    }
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, params.content, 'utf-8');
    return {
      content: [{ type: 'text', text: 'OK' }],
      details: { path: fullPath, bytes: params.content.length },
    };
  },
};
