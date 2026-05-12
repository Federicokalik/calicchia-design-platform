function esc(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface ReceiptLineItem {
  description: string;
  quantity?: number;
  unit_price?: number;
  amount: number;
}

export interface ReceiptData {
  receipt_number: string;
  issued_at: string;
  customer_name: string;
  customer_email?: string | null;
  customer_address?: string | null;
  amount: number;
  currency: string;
  paid_at?: string | null;
  provider: string;
  provider_reference?: string | null;
  invoice_number?: string | null;
  line_items?: ReceiptLineItem[];
}

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amount);
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  return new Intl.DateTimeFormat('it-IT', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(new Date(value));
}

export function renderReceiptHtml(data: ReceiptData): string {
  const lineItems = data.line_items ?? [];
  const rows = lineItems.map((item) => `
    <tr>
      <td>${esc(item.description)}</td>
      <td class="num">${esc(item.quantity ?? 1)}</td>
      <td class="num">${item.unit_price != null ? esc(formatMoney(item.unit_price, data.currency)) : ''}</td>
      <td class="num strong">${esc(formatMoney(item.amount, data.currency))}</td>
    </tr>
  `).join('');

  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <title>${esc(data.receipt_number)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #171717;
      background: #ffffff;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 12px;
      line-height: 1.45;
    }
    .page { padding: 8mm 0; }
    .top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 1px solid #171717;
      padding-bottom: 22px;
      margin-bottom: 34px;
    }
    .brand {
      font-size: 26px;
      font-weight: 700;
      letter-spacing: .08em;
    }
    .doc {
      text-align: right;
      text-transform: uppercase;
      letter-spacing: .08em;
      font-size: 10px;
    }
    .doc strong {
      display: block;
      margin-top: 8px;
      font-size: 18px;
      letter-spacing: 0;
    }
    .subtitle {
      margin: 0 0 28px;
      color: #5f5f5f;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .12em;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 28px;
      margin-bottom: 32px;
    }
    .label {
      color: #6b6b6b;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: .14em;
      margin-bottom: 8px;
      text-transform: uppercase;
    }
    .box {
      border-top: 1px solid #d9d9d9;
      padding-top: 12px;
      min-height: 88px;
    }
    .box p { margin: 0 0 5px; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
    }
    th {
      border-bottom: 1px solid #171717;
      color: #6b6b6b;
      font-size: 9px;
      letter-spacing: .12em;
      padding: 9px 0;
      text-align: left;
      text-transform: uppercase;
    }
    td {
      border-bottom: 1px solid #e7e7e7;
      padding: 12px 0;
      vertical-align: top;
    }
    .num { text-align: right; }
    .strong { font-weight: 700; }
    .total {
      display: flex;
      justify-content: flex-end;
      margin-top: 20px;
    }
    .total div {
      min-width: 220px;
      border-top: 1px solid #171717;
      padding-top: 14px;
      display: flex;
      justify-content: space-between;
      font-size: 15px;
      font-weight: 700;
    }
    .footer {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      border-top: 1px solid #d9d9d9;
      padding-top: 12px;
      color: #6b6b6b;
      font-size: 10px;
      display: flex;
      justify-content: space-between;
    }
  </style>
</head>
<body>
  <main class="page">
    <header class="top">
      <div class="brand">CALICCHIA</div>
      <div class="doc">
        Ricevuta
        <strong>${esc(data.receipt_number)}</strong>
      </div>
    </header>

    <p class="subtitle">Ricevuta pro-forma di pagamento</p>

    <section class="grid">
      <div>
        <div class="label">Cliente</div>
        <div class="box">
          <p class="strong">${esc(data.customer_name)}</p>
          ${data.customer_email ? `<p>${esc(data.customer_email)}</p>` : ''}
          ${data.customer_address ? `<p>${esc(data.customer_address)}</p>` : ''}
        </div>
      </div>
      <div>
        <div class="label">Pagamento</div>
        <div class="box">
          <p><span class="strong">Metodo:</span> ${esc(data.provider)}</p>
          <p><span class="strong">Pagato il:</span> ${esc(formatDate(data.paid_at))}</p>
          ${data.invoice_number ? `<p><span class="strong">Riferimento:</span> ${esc(data.invoice_number)}</p>` : ''}
          ${data.provider_reference ? `<p><span class="strong">ID:</span> ${esc(data.provider_reference)}</p>` : ''}
        </div>
      </div>
    </section>

    ${lineItems.length > 0 ? `
      <table>
        <thead>
          <tr>
            <th>Descrizione</th>
            <th class="num">Q.ta</th>
            <th class="num">Unitario</th>
            <th class="num">Importo</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    ` : ''}

    <section class="total">
      <div>
        <span>Totale pagato</span>
        <span>${esc(formatMoney(data.amount, data.currency))}</span>
      </div>
    </section>
  </main>
  <footer class="footer">
    <span>Calicchia Design</span>
    <span>${esc(formatDate(data.issued_at))}</span>
  </footer>
</body>
</html>`;
}
