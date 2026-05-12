/**
 * Telegram Bot API wrapper
 */

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = () => process.env.TELEGRAM_CHAT_ID || '';

function apiUrl(method: string) {
  return `https://api.telegram.org/bot${BOT_TOKEN()}/${method}`;
}

export function isTelegramConfigured(): boolean {
  return !!BOT_TOKEN() && !!CHAT_ID();
}

export function isAuthorizedChat(chatId: string | number): boolean {
  return String(chatId) === CHAT_ID();
}

/**
 * Send a text message
 */
export async function sendTelegramMessage(
  text: string,
  chatId?: string,
  options?: { parse_mode?: 'MarkdownV2' | 'HTML'; disable_notification?: boolean }
): Promise<boolean> {
  if (!BOT_TOKEN()) return false;

  try {
    const res = await fetch(apiUrl('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        chat_id: chatId || CHAT_ID(),
        text,
        parse_mode: options?.parse_mode || 'HTML',
        disable_notification: options?.disable_notification || false,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Telegram sendMessage error:', err);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Telegram error:', err);
    return false;
  }
}

/**
 * Set webhook URL
 */
export async function setTelegramWebhook(url: string): Promise<boolean> {
  if (!BOT_TOKEN()) return false;

  const res = await fetch(apiUrl('setWebhook'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ url, allowed_updates: ['message'] }),
  });

  return res.ok;
}

/**
 * Send notification (convenience wrapper with HTML formatting)
 */
export async function notifyTelegram(title: string, body: string): Promise<boolean> {
  const text = `<b>${escapeHtml(title)}</b>\n${escapeHtml(body)}`;
  return sendTelegramMessage(text);
}

/**
 * Send message with inline keyboard buttons
 */
export async function sendTelegramWithButtons(
  text: string,
  buttons: Array<Array<{ text: string; callback_data: string }>>,
  chatId?: string
): Promise<boolean> {
  if (!BOT_TOKEN()) return false;

  try {
    const res = await fetch(apiUrl('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        chat_id: chatId || CHAT_ID(),
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      }),
    });
    return res.ok;
  } catch { return false; }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
