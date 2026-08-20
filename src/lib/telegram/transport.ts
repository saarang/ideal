/**
 * Telegram transport. TELEGRAM_MODE=real talks to api.telegram.org with
 * TELEGRAM_BOT_TOKEN; TELEGRAM_MODE=mock (default) writes outgoing messages to
 * the telegram_outbox table and serves file downloads from local fixture
 * paths, so the whole intake flow is testable offline — including from the
 * built-in simulator at /dev/telegram.
 *
 * Connecting the real bot (see also docs/DEPLOYMENT.md):
 *   1. Create a bot with @BotFather, copy the token into TELEGRAM_BOT_TOKEN.
 *   2. Set TELEGRAM_MODE=real and either
 *        a. expose /api/telegram/webhook publicly and register it:
 *           curl "https://api.telegram.org/bot<token>/setWebhook?url=https://your.app/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
 *        b. or run `npm run telegram:poll` (long-polling; no public URL needed).
 *   3. Add the bot to the family group and send a photo.
 */
import { getPool, dq } from '../db';

export interface TgPhotoSize { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }
export interface TgDocument { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number }
export interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number | string; type: string; title?: string };
  from?: { id: number; first_name?: string; last_name?: string; username?: string };
  caption?: string;
  text?: string;
  media_group_id?: string;
  photo?: TgPhotoSize[];
  document?: TgDocument;
}
export interface TgUpdate { update_id: number; message?: TgMessage; edited_message?: TgMessage }

export interface TelegramTransport {
  mode: 'real' | 'mock';
  sendMessage(chatId: string, text: string): Promise<void>;
  /** Download a file by file_id; returns bytes + a best-effort filename. */
  getFile(fileId: string): Promise<{ buffer: Buffer; filename: string }>;
}

class RealTransport implements TelegramTransport {
  mode = 'real' as const;
  private base: string;
  constructor(private token: string) {
    this.base = `https://api.telegram.org/bot${token}`;
  }
  async sendMessage(chatId: string, text: string): Promise<void> {
    const res = await fetch(`${this.base}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const pool = getPool();
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      await dq(pool, `INSERT INTO telegram_outbox (chat_id, text, status, error) VALUES ($1,$2,'FAILED',$3)`,
        [chatId, text, `HTTP ${res.status}: ${body.slice(0, 300)}`]);
      return;
    }
    await dq(pool, `INSERT INTO telegram_outbox (chat_id, text, status) VALUES ($1,$2,'SENT')`, [chatId, text]);
  }
  async getFile(fileId: string): Promise<{ buffer: Buffer; filename: string }> {
    const meta = await fetch(`${this.base}/getFile?file_id=${encodeURIComponent(fileId)}`).then((r) => r.json());
    if (!meta?.ok) throw new Error(`Telegram getFile failed: ${JSON.stringify(meta).slice(0, 200)}`);
    const path: string = meta.result.file_path;
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${path}`);
    if (!res.ok) throw new Error(`Telegram file download failed: HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, filename: path.split('/').pop() || 'telegram.jpg' };
  }
}

class MockTransport implements TelegramTransport {
  mode = 'mock' as const;
  async sendMessage(chatId: string, text: string): Promise<void> {
    await dq(getPool(), `INSERT INTO telegram_outbox (chat_id, text, status) VALUES ($1,$2,'MOCKED')`, [chatId, text]);
  }
  async getFile(fileId: string): Promise<{ buffer: Buffer; filename: string }> {
    // In mock mode the simulator passes a local file path as the file_id.
    const fs = await import('fs/promises');
    const pathMod = await import('path');
    const buffer = await fs.readFile(fileId);
    return { buffer, filename: pathMod.basename(fileId) };
  }
}

let transport: TelegramTransport | null = null;
export function getTelegram(): TelegramTransport {
  if (transport) return transport;
  const mode = (process.env.TELEGRAM_MODE ?? 'mock').toLowerCase();
  if (mode === 'real') {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_MODE=real but TELEGRAM_BOT_TOKEN is not set.');
    transport = new RealTransport(token);
  } else {
    transport = new MockTransport();
  }
  return transport;
}
export function resetTelegram() { transport = null; }
