import http, { IncomingMessage, ServerResponse } from 'http';
import crypto from 'crypto';

import {
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  FEISHU_BASE_URL,
  FEISHU_ENCRYPT_KEY,
  FEISHU_PORT,
  FEISHU_VERIFICATION_TOKEN,
} from '../config.js';
import { Channel, NewMessage } from '../types.js';
import { logger } from '../logger.js';
import { registerChannel, type ChannelOpts } from './registry.js';

const CALLBACK_PATH = process.env.FEISHU_CALLBACK_PATH || '/feishu/events';

interface FeishuTokenCache {
  token: string;
  expiresAt: number;
}

class FeishuChannel implements Channel {
  name = 'feishu';
  private server: http.Server | null = null;
  private connected = false;
  private tokenCache: FeishuTokenCache | null = null;

  constructor(private opts: ChannelOpts) {}

  async connect(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => {
      this.server!.listen(FEISHU_PORT, () => resolve());
    });
    this.connected = true;
    logger.info({ port: FEISHU_PORT }, 'Feishu channel listening');
  }

  async disconnect(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('fs:');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.replace(/^fs:/, '');
    const token = await this.getAccessToken();
    const url = `${FEISHU_BASE_URL}/open-apis/im/v1/messages?receive_id_type=chat_id`;
    const body = {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      logger.warn({ status: resp.status, detail }, 'Feishu sendMessage failed');
    }
  }

  async syncGroups(): Promise<void> {
    // Feishu does not provide a simple group list endpoint for bots.
    return;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || req.url?.split('?')[0] !== CALLBACK_PATH) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      if (!this.verifySignature(req, body)) {
        res.writeHead(401);
        res.end('Invalid signature');
        return;
      }

      let payload: any;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end('Bad JSON');
        return;
      }

      if (payload.encrypt && FEISHU_ENCRYPT_KEY) {
        res.writeHead(400);
        res.end('Encrypted payload not supported yet');
        return;
      }

      if (payload.type === 'url_verification') {
        if (FEISHU_VERIFICATION_TOKEN && payload.token !== FEISHU_VERIFICATION_TOKEN) {
          res.writeHead(403);
          res.end('Invalid token');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ challenge: payload.challenge }));
        return;
      }

      if (payload.event?.message) {
        const evt = payload.event;
        const msg = evt.message;
        const sender = evt.sender?.sender_id?.open_id || evt.sender?.sender_id?.user_id || 'unknown';
        const chatId = msg.chat_id;
        const chatJid = `fs:${chatId}`;
        const msgId = msg.message_id || `${Date.now()}-${Math.random()}`;
        const timestamp = new Date().toISOString();
        let contentText = '';
        if (msg.message_type === 'text') {
          try {
            const content = JSON.parse(msg.content || '{}');
            contentText = content.text || '';
          } catch {
            contentText = msg.content || '';
          }
        } else {
          contentText = `[${msg.message_type}]`;
        }

        const message: NewMessage = {
          id: msgId,
          chat_jid: chatJid,
          sender,
          sender_name: sender,
          content: contentText,
          timestamp,
          is_from_me: false,
          is_bot_message: false,
        };

        this.opts.onChatMetadata(chatJid, timestamp, msg.chat_id, 'feishu', msg.chat_type === 'group');
        this.opts.onMessage(chatJid, message);
      }

      res.writeHead(200);
      res.end('ok');
    });
  }

  private verifySignature(req: IncomingMessage, body: string): boolean {
    if (!FEISHU_APP_SECRET) return false;
    const timestamp = req.headers['x-lark-request-timestamp'] as string | undefined;
    const nonce = req.headers['x-lark-request-nonce'] as string | undefined;
    const signature = req.headers['x-lark-signature'] as string | undefined;

    if (!timestamp || !nonce || !signature) return false;
    const ts = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 60 * 5) {
      logger.warn('Feishu signature timestamp invalid');
      return false;
    }

    const base = `${timestamp}${nonce}${body}${FEISHU_APP_SECRET}`;
    const expected = crypto.createHash('sha256').update(base).digest('hex');
    return expected === signature;
  }

  private async getAccessToken(): Promise<string> {
    if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
      throw new Error('Feishu credentials missing');
    }
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 30_000) {
      return this.tokenCache.token;
    }

    const resp = await fetch(`${FEISHU_BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(`Feishu token error: ${detail}`);
    }

    const data = (await resp.json()) as { tenant_access_token: string; expire: number };
    this.tokenCache = {
      token: data.tenant_access_token,
      expiresAt: Date.now() + data.expire * 1000,
    };
    return this.tokenCache.token;
  }
}

registerChannel('feishu', (opts) => {
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
    return null;
  }
  if (FEISHU_ENCRYPT_KEY) {
    logger.warn('Feishu encrypt key provided but encryption handling is not implemented');
  }
  return new FeishuChannel(opts);
});
