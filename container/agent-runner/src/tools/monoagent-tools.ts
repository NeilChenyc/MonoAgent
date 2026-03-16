import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const MEMORY_DIR = path.join(IPC_DIR, 'memory');

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

export function createIpcTools(input: {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
}): AgentTool[] {
  const sendMessageTool: AgentTool = {
    name: 'send_message',
    label: 'Send Message',
    description: 'Send a message back to the chat immediately.',
    parameters: Type.Object({
      text: Type.String(),
      sender: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      writeIpcFile(MESSAGES_DIR, {
        type: 'message',
        chatJid: input.chatJid,
        text: params.text,
        sender: params.sender,
        groupFolder: input.groupFolder,
        timestamp: new Date().toISOString(),
      });
      return {
        content: [{ type: 'text', text: 'Message queued.' }],
        details: { ok: true },
      };
    },
  };

  const scheduleTaskTool: AgentTool = {
    name: 'schedule_task',
    label: 'Schedule Task',
    description: 'Schedule a recurring or one-time task.',
    parameters: Type.Object({
      prompt: Type.String(),
      schedule_type: Type.Union([
        Type.Literal('cron'),
        Type.Literal('interval'),
        Type.Literal('once'),
      ]),
      schedule_value: Type.String(),
      context_mode: Type.Optional(
        Type.Union([Type.Literal('group'), Type.Literal('isolated')]),
      ),
      target_group_jid: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      if (params.schedule_type === 'cron') {
        CronExpressionParser.parse(params.schedule_value);
      }
      if (params.schedule_type === 'interval') {
        const ms = parseInt(params.schedule_value, 10);
        if (Number.isNaN(ms) || ms <= 0) throw new Error('Invalid interval');
      }
      if (params.schedule_type === 'once') {
        const date = new Date(params.schedule_value);
        if (Number.isNaN(date.getTime())) throw new Error('Invalid timestamp');
      }

      const targetJid = input.isMain && params.target_group_jid
        ? params.target_group_jid
        : input.chatJid;

      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'schedule_task',
        taskId,
        prompt: params.prompt,
        schedule_type: params.schedule_type,
        schedule_value: params.schedule_value,
        context_mode: params.context_mode || 'group',
        targetJid,
        createdBy: input.groupFolder,
        timestamp: new Date().toISOString(),
      });

      return {
        content: [{ type: 'text', text: `Task ${taskId} scheduled.` }],
        details: { taskId },
      };
    },
  };

  const listTasksTool: AgentTool = {
    name: 'list_tasks',
    label: 'List Tasks',
    description: 'List scheduled tasks.',
    parameters: Type.Object({}),
    execute: async () => {
      const tasksFile = path.join(IPC_DIR, 'current_tasks.json');
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text', text: 'No tasks found.' }], details: { tasks: [] } };
      }
      const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8')) as Array<{
        id: string;
        groupFolder: string;
        prompt: string;
        schedule_type: string;
        schedule_value: string;
        status: string;
        next_run: string | null;
      }>;
      const visible = input.isMain
        ? tasks
        : tasks.filter((t) => t.groupFolder === input.groupFolder);
      const formatted = visible
        .map(
          (t) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}`,
        )
        .join('\n');
      return {
        content: [{ type: 'text', text: formatted || 'No tasks found.' }],
        details: { tasks: visible },
      };
    },
  };

  const pauseTaskTool: AgentTool = {
    name: 'pause_task',
    label: 'Pause Task',
    description: 'Pause a scheduled task.',
    parameters: Type.Object({
      taskId: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      writeIpcFile(TASKS_DIR, { type: 'pause_task', taskId: params.taskId });
      return {
        content: [{ type: 'text', text: `Task ${params.taskId} paused.` }],
      };
    },
  };

  const resumeTaskTool: AgentTool = {
    name: 'resume_task',
    label: 'Resume Task',
    description: 'Resume a paused task.',
    parameters: Type.Object({
      taskId: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      writeIpcFile(TASKS_DIR, { type: 'resume_task', taskId: params.taskId });
      return {
        content: [{ type: 'text', text: `Task ${params.taskId} resumed.` }],
      };
    },
  };

  const cancelTaskTool: AgentTool = {
    name: 'cancel_task',
    label: 'Cancel Task',
    description: 'Cancel (delete) a scheduled task.',
    parameters: Type.Object({
      taskId: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      writeIpcFile(TASKS_DIR, { type: 'cancel_task', taskId: params.taskId });
      return {
        content: [{ type: 'text', text: `Task ${params.taskId} cancelled.` }],
      };
    },
  };

  const updateTaskTool: AgentTool = {
    name: 'update_task',
    label: 'Update Task',
    description: 'Update a scheduled task prompt or schedule.',
    parameters: Type.Object({
      taskId: Type.String(),
      prompt: Type.Optional(Type.String()),
      schedule_type: Type.Optional(
        Type.Union([Type.Literal('cron'), Type.Literal('interval'), Type.Literal('once')]),
      ),
      schedule_value: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      if (params.schedule_type === 'cron' && params.schedule_value) {
        CronExpressionParser.parse(params.schedule_value);
      }
      if (params.schedule_type === 'interval' && params.schedule_value) {
        const ms = parseInt(params.schedule_value, 10);
        if (Number.isNaN(ms) || ms <= 0) throw new Error('Invalid interval');
      }
      if (params.schedule_type === 'once' && params.schedule_value) {
        const date = new Date(params.schedule_value);
        if (Number.isNaN(date.getTime())) throw new Error('Invalid timestamp');
      }

      writeIpcFile(TASKS_DIR, {
        type: 'update_task',
        taskId: params.taskId,
        prompt: params.prompt,
        schedule_type: params.schedule_type,
        schedule_value: params.schedule_value,
      });
      return {
        content: [{ type: 'text', text: `Task ${params.taskId} updated.` }],
      };
    },
  };

  const writeMemoryTool: AgentTool = {
    name: 'write_memory',
    label: 'Write Memory',
    description: 'Store a memory item for long-term retrieval.',
    parameters: Type.Object({
      content: Type.String(),
      summary: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
      source: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      writeIpcFile(MEMORY_DIR, {
        type: 'write_memory',
        content: params.content,
        summary: params.summary,
        tags: params.tags,
        source: params.source,
      });
      return {
        content: [{ type: 'text', text: 'Memory queued.' }],
        details: { ok: true },
      };
    },
  };

  return [
    sendMessageTool,
    scheduleTaskTool,
    listTasksTool,
    pauseTaskTool,
    resumeTaskTool,
    cancelTaskTool,
    updateTaskTool,
    writeMemoryTool,
  ];
}
