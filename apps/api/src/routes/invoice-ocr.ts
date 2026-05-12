import { Hono } from 'hono';
import { getProviderForTask, callOpenAICompatible } from '../lib/agent/llm-router';
import type { LLMTask } from '../lib/agent/llm-router';

export const invoiceOcr = new Hono();

const EXTRACT_PROMPT = `Sei un assistente specializzato nell'estrazione dati da fatture italiane.
Analizza l'immagine della fattura e restituisci SOLO un JSON valido con questa struttura:

{
  "invoice_number": "numero fattura (es. FT-2026-0042)",
  "customer_name": "ragione sociale o nome cliente",
  "customer_email": "email se visibile, altrimenti null",
  "description": "descrizione sintetica dei servizi/prodotti fatturati",
  "subtotal": 0.00,
  "tax_rate": 22,
  "tax_amount": 0.00,
  "total": 0.00,
  "issue_date": "YYYY-MM-DD",
  "due_date": "YYYY-MM-DD o null se non indicata",
  "payment_terms": "termini di pagamento se indicati, altrimenti null",
  "line_items": [
    { "description": "voce", "quantity": 1, "unit_price": 0.00, "amount": 0.00 }
  ]
}

Regole:
- Importi come numeri decimali (es. 1500.00), MAI stringhe
- Date in formato ISO YYYY-MM-DD
- Se un campo non è presente nella fattura, usa null
- Includi TUTTE le voci trovate in line_items
- Per l'IVA, estrai l'aliquota effettiva (4%, 10%, 22%, ecc.)
- Se trovi "esente IVA" o "regime forfettario", imposta tax_rate a 0
- Rispondi SOLO con il JSON, nessun testo aggiuntivo`;

// POST /api/ai/extract-invoice — Extract data from invoice PDF/image
invoiceOcr.post('/extract-invoice', async (c) => {
  const contentType = c.req.header('content-type') || '';

  let fileBuffer: ArrayBuffer;
  let mimeType: string;

  if (contentType.includes('multipart/form-data')) {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    if (!file) return c.json({ error: 'File richiesto' }, 400);

    const allowed = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
    if (!allowed.includes(file.type)) {
      return c.json({ error: 'Formato non supportato. Usa PDF, PNG, JPEG o WebP' }, 400);
    }
    if (file.size > 20 * 1024 * 1024) {
      return c.json({ error: 'File troppo grande (max 20MB)' }, 400);
    }

    fileBuffer = await file.arrayBuffer();
    mimeType = file.type;
  } else {
    return c.json({ error: 'Invia il file come multipart/form-data' }, 400);
  }

  const base64 = Buffer.from(fileBuffer).toString('base64');

  try {
    const config = getProviderForTask('invoice_ocr' as LLMTask);

    // Build vision message with image content
    const messages: any[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: EXTRACT_PROMPT },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${base64}`,
              detail: 'high',
            },
          },
        ],
      },
    ];

    const data = await callOpenAICompatible(config, messages, {
      temperature: 0.1,
      max_tokens: 2000,
      _task: 'invoice_ocr',
      _channel: 'admin',
    });

    const rawContent = data.choices?.[0]?.message?.content || '';

    // Parse JSON from response (handle markdown code blocks)
    let extracted: Record<string, unknown>;
    try {
      const jsonMatch = rawContent.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, rawContent];
      extracted = JSON.parse(jsonMatch[1]!.trim());
    } catch {
      return c.json({ error: 'Impossibile estrarre dati dalla fattura', raw: rawContent }, 422);
    }

    return c.json({ extracted });
  } catch (err: any) {
    console.error('[Invoice OCR] Error:', err.message);
    return c.json({ error: 'Errore AI durante l\'estrazione della fattura' }, 500);
  }
});
