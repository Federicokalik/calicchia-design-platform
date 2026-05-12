import { Hono } from 'hono';
import { runAgent } from '../lib/agent';
import { sendTelegramMessage, isAuthorizedChat, isTelegramConfigured } from '../lib/telegram';

export const telegram = new Hono();

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || '';

/**
 * Transcribe audio file using Infomaniak Whisper V3
 */
async function transcribeAudio(fileUrl: string): Promise<string> {
  const infoToken = process.env.INFOMANIAK_AI_TOKEN;
  const productId = process.env.INFOMANIAK_AI_PRODUCT_ID;

  if (!infoToken || !productId) {
    // Fallback: OpenAI Whisper
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) throw new Error('Nessun provider audio configurato');

    const audioRes = await fetch(fileUrl);
    const audioBlob = await audioRes.blob();

    const form = new FormData();
    form.append('file', audioBlob, 'audio.ogg');
    form.append('model', 'whisper-1');
    form.append('language', 'it');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}` },
      body: form,
    });

    if (!res.ok) throw new Error(`OpenAI Whisper error: ${res.status}`);
    const data = await res.json();
    return data.text || '';
  }

  // Infomaniak Whisper
  const audioRes = await fetch(fileUrl);
  const audioBlob = await audioRes.blob();

  const form = new FormData();
  form.append('file', audioBlob, 'audio.ogg');
  form.append('model', 'whisper-v3');
  form.append('language', 'it');

  const res = await fetch(`https://api.infomaniak.com/2/ai/${productId}/openai/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${infoToken}` },
    body: form,
  });

  if (!res.ok) throw new Error(`Infomaniak Whisper error: ${res.status}`);
  const data = await res.json();
  return data.text || '';
}

/**
 * Get Telegram file URL from file_id
 */
async function getTelegramFileUrl(fileId: string): Promise<string> {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/getFile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error('Cannot get file');
  return `https://api.telegram.org/file/bot${BOT_TOKEN()}/${data.result.file_path}`;
}

/**
 * Send reply, splitting if > 4000 chars
 */
async function sendReply(chatId: string, text: string) {
  if (text.length <= 4000) {
    await sendTelegramMessage(text, chatId, { parse_mode: 'HTML' });
  } else {
    const chunks = text.match(/.{1,4000}/gs) || [text];
    for (const chunk of chunks) {
      await sendTelegramMessage(chunk, chatId, { parse_mode: 'HTML' });
    }
  }
}

// POST /api/telegram/webhook
telegram.post('/webhook', async (c) => {
  if (!isTelegramConfigured()) return c.json({ ok: true });

  const update = await c.req.json();

  // Handle callback query (inline buttons)
  if (update?.callback_query) {
    const cb = update.callback_query;
    if (!isAuthorizedChat(cb.message?.chat?.id)) return c.json({ ok: true });

    const chatId = String(cb.message.chat.id);
    const result = await runAgent({
      message: `L'utente ha cliccato il bottone: ${cb.data}. Esegui l'azione corrispondente.`,
      channel: 'telegram',
      context: 'telegram_callback',
    });

    await sendReply(chatId, result.reply);

    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cb.id }),
      });
    } catch {}

    return c.json({ ok: true });
  }

  const message = update?.message;
  if (!message?.chat?.id) return c.json({ ok: true });
  if (!isAuthorizedChat(message.chat.id)) return c.json({ ok: true });

  const chatId = String(message.chat.id);

  // Handle VOICE messages
  if (message.voice || message.audio) {
    const fileId = message.voice?.file_id || message.audio?.file_id;
    if (!fileId) return c.json({ ok: true });

    try {
      await sendTelegramMessage('🎤 Trascrizione in corso...', chatId, { disable_notification: true });

      const fileUrl = await getTelegramFileUrl(fileId);
      const transcript = await transcribeAudio(fileUrl);

      if (!transcript.trim()) {
        await sendTelegramMessage('Non sono riuscito a trascrivere l\'audio.', chatId);
        return c.json({ ok: true });
      }

      // Process transcribed text through agent
      const result = await runAgent({
        message: transcript,
        channel: 'telegram',
        context: 'telegram_voice',
      });

      await sendReply(chatId, `🎤 <i>${transcript}</i>\n\n${result.reply}`);
    } catch (err) {
      console.error('[Telegram] Voice error:', err);
      await sendTelegramMessage('Errore nella trascrizione audio.', chatId);
    }

    return c.json({ ok: true });
  }

  // Handle TEXT messages
  if (!message.text) return c.json({ ok: true });

  const text = message.text.trim();
  const result = await runAgent({
    message: text,
    channel: 'telegram',
    context: 'telegram',
  });

  await sendReply(chatId, result.reply);
  return c.json({ ok: true });
});

// GET /api/telegram/status
telegram.get('/status', async (c) => {
  return c.json({
    configured: isTelegramConfigured(),
    chat_id: process.env.TELEGRAM_CHAT_ID ? '***' + process.env.TELEGRAM_CHAT_ID.slice(-4) : null,
  });
});
