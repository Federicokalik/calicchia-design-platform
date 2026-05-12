const EVO_API_URL = process.env.EVOLUTION_API_URL || 'https://evoapi.calicchia.design';
const EVO_API_KEY = process.env.EVOLUTION_API_KEY || '';
const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE || 'default';

function evoHeaders() {
  return {
    'Content-Type': 'application/json',
    apikey: EVO_API_KEY,
  };
}

function formatPhone(phone: string): string {
  // Ensure format: country code + number, no spaces/dashes
  let cleaned = phone.replace(/[\s\-()]/g, '');
  // If starts with +, remove it
  if (cleaned.startsWith('+')) cleaned = cleaned.slice(1);
  // If Italian number without country code, add 39
  if (cleaned.startsWith('3') && cleaned.length === 10) cleaned = `39${cleaned}`;
  return cleaned;
}

export function isWhatsAppConfigured(): boolean {
  return !!EVO_API_KEY;
}

/**
 * Send a text message via WhatsApp
 */
export async function sendWhatsAppText(phone: string, message: string): Promise<{ success: boolean; messageId?: string }> {
  if (!isWhatsAppConfigured()) throw new Error('WhatsApp (Evolution API) non configurato');

  const number = formatPhone(phone);

  const res = await fetch(`${EVO_API_URL}/message/sendText/${EVO_INSTANCE}`, {
    method: 'POST',
    headers: evoHeaders(),
    body: JSON.stringify({
      number,
      text: message,
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    console.error('WhatsApp sendText error:', error);
    throw new Error(`Errore invio WhatsApp: ${res.status}`);
  }

  const data = await res.json();
  return { success: true, messageId: data?.key?.id };
}

/**
 * Send a media message (PDF, image, etc.) via WhatsApp
 */
export async function sendWhatsAppMedia(
  phone: string,
  caption: string,
  mediaUrl: string,
  filename: string,
  mimetype = 'application/pdf'
): Promise<{ success: boolean; messageId?: string }> {
  if (!isWhatsAppConfigured()) throw new Error('WhatsApp (Evolution API) non configurato');

  const number = formatPhone(phone);

  const res = await fetch(`${EVO_API_URL}/message/sendMedia/${EVO_INSTANCE}`, {
    method: 'POST',
    headers: evoHeaders(),
    body: JSON.stringify({
      number,
      mediatype: 'document',
      media: mediaUrl,
      caption,
      fileName: filename,
      mimetype,
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    console.error('WhatsApp sendMedia error:', error);
    throw new Error(`Errore invio media WhatsApp: ${res.status}`);
  }

  const data = await res.json();
  return { success: true, messageId: data?.key?.id };
}

/**
 * Check connection status
 */
export async function getWhatsAppStatus(): Promise<{ connected: boolean; phone?: string }> {
  if (!isWhatsAppConfigured()) return { connected: false };

  try {
    const res = await fetch(`${EVO_API_URL}/instance/connectionState/${EVO_INSTANCE}`, {
      headers: evoHeaders(),
    });
    if (!res.ok) return { connected: false };
    const data = await res.json();
    return { connected: data?.state === 'open', phone: data?.instance?.owner };
  } catch {
    return { connected: false };
  }
}
