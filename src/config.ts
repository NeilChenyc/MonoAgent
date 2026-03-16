import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'monoagent',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'monoagent',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'monoagent-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Embeddings (OpenAI-compatible)
export const EMBEDDINGS_BASE_URL =
  process.env.EMBEDDINGS_BASE_URL ||
  process.env.OPENAI_BASE_URL ||
  'https://api.openai.com/v1';
export const EMBEDDINGS_MODEL =
  process.env.EMBEDDINGS_MODEL || 'text-embedding-3-large';
export const EMBEDDINGS_API_KEY =
  process.env.EMBEDDINGS_API_KEY || process.env.OPENAI_API_KEY;
export const MEMORY_DEDUP_THRESHOLD = parseFloat(
  process.env.MEMORY_DEDUP_THRESHOLD || '0.88',
);
export const MEMORY_TOP_K = parseInt(process.env.MEMORY_TOP_K || '5', 10);

// Feishu (Lark) channel
export const FEISHU_PORT = parseInt(process.env.FEISHU_PORT || '3002', 10);
export const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
export const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
export const FEISHU_VERIFICATION_TOKEN =
  process.env.FEISHU_VERIFICATION_TOKEN;
export const FEISHU_ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY;
export const FEISHU_BASE_URL =
  process.env.FEISHU_BASE_URL || 'https://open.feishu.cn';
