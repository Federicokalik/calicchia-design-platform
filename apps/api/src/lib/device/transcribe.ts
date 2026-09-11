/**
 * Trascrizione note vocali via Gemini (audio inline, REST nativo).
 *
 * Il router OpenAI-compatible (llm-router.ts) è text/image-only: per l'audio
 * usiamo generateContent con inline_data, che non richiede upload su File API
 * per clip brevi (< ~20 MB). WAV 16kHz mono del dispositivo ≈ 2 MB/min.
 */
import { logger } from '../logger';

const log = logger.child({ scope: 'device-transcribe' });

const GEMINI_MODEL = 'gemini-2.5-flash';

export function isTranscriptionConfigured(): boolean {
  return Boolean(process.env.GOOGLE_AI_API_KEY);
}

export async function transcribeWav(
  buffer: Buffer,
  mimeType = 'audio/wav',
): Promise<string> {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_AI_API_KEY mancante — trascrizione non disponibile');
  }

  // Chiavi AI Studio di nuova generazione (prefisso AQ.*) richiedono l'header
  // x-goog-api-key; il query param ?key= non è supportato.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const body = {
    contents: [
      {
        parts: [
          {
            text:
              'Trascrivi integralmente questa registrazione vocale. È una nota ' +
              'di lavoro dell\'autore, in italiano (possibili parole in inglese). ' +
              'Restituisci SOLO il testo trascritto, pulito da esitazioni e ripetute, ' +
              'senza commenti, titoli o formattazione markdown. Se l\'audio è ' +
              'silenzio o non contiene parlato, rispondi esattamente: [vuoto]',
          },
          { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } },
        ],
      },
    ],
    generationConfig: { temperature: 0, maxOutputTokens: 2048 },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log.error({ status: res.status, body: text.slice(0, 300) }, 'Gemini trascrizione fallita');
    throw new Error(`Gemini HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = jsonText(json);
  return text;
}

function jsonText(json: {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}): string {
  return (
    json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
  );
}
