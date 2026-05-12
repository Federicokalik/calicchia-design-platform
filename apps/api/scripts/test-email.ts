/**
 * Smoke test per il sistema email hybrid.
 *
 * Usage:
 *   pnpm --filter @caldes/api exec tsx --env-file=../../.env \
 *     scripts/test-email.ts <critical|standard> <to-email>
 *
 * Esempio:
 *   pnpm --filter @caldes/api exec tsx --env-file=../../.env \
 *     scripts/test-email.ts critical federico@calicchia.design
 *
 * Modalità senza argomenti: compila tutti i 10 template + stampa primo
 * snippet HTML per ognuno (utile per validare MJML compilation).
 */
import { sendEmail } from '../src/lib/email';
import { renderMagicLinkEmail } from '../src/templates/magic-link';
import { renderPaymentConfirmedEmail } from '../src/templates/payment-confirmed';
import { renderContractSignedEmail } from '../src/templates/contract-signed';
import { renderOtpCodeEmail } from '../src/templates/otp-code';
import { renderContactFormEmail } from '../src/templates/contact-form';
import { renderDomainExpiringEmail } from '../src/templates/domain-expiring';
import { renderMaterialRequestEmail } from '../src/templates/material-request';
import { renderReportPublishedEmail } from '../src/templates/report-published';
import { renderQuoteInviteEmail } from '../src/templates/quote-invite';
import { renderGdprRequestEmail } from '../src/templates/gdpr-request';

async function compileAllTemplates() {
  const tests = [
    {
      name: 'magic-link',
      fn: () =>
        renderMagicLinkEmail({
          contactName: 'Mario Rossi',
          link: 'https://calicchia.design/clienti/auth/verify?token=abc',
          expiresMinutes: 15,
        }),
    },
    {
      name: 'payment-confirmed',
      fn: () =>
        renderPaymentConfirmedEmail({
          contactName: 'Mario Rossi',
          invoiceNumber: 'INV-2026-001',
          amountLabel: '€ 1.234,56',
          paidAt: '10 maggio 2026',
        }),
    },
    {
      name: 'contract-signed',
      fn: () =>
        renderContractSignedEmail({
          contactName: 'Mario Rossi',
          quoteNumber: 'PREV-2026-001',
          totalLabel: '€ 4.500,00',
          signedAt: '10 maggio 2026',
        }),
    },
    {
      name: 'otp-code',
      fn: () => renderOtpCodeEmail({ code: '123456', expiresMinutes: 10 }),
    },
    {
      name: 'contact-form',
      fn: () =>
        renderContactFormEmail({
          name: 'Mario Rossi',
          email: 'mario@example.com',
          phone: '+39 333 1234567',
          company: 'Acme Srl',
          message: 'Vorrei un preventivo per il sito.',
          wantsMeet: true,
          source: '/contatti',
        }),
    },
    {
      name: 'domain-expiring',
      fn: () =>
        renderDomainExpiringEmail({
          contactName: 'Mario Rossi',
          domains: [
            { name: 'example.com', expirationDate: '15 mag 2026', daysUntilExpiry: 5 },
            { name: 'example.it', expirationDate: '20 mag 2026', daysUntilExpiry: 10 },
          ],
          renewUrl: 'https://calicchia.design/contatti',
        }),
    },
    {
      name: 'material-request',
      fn: () =>
        renderMaterialRequestEmail({
          contactName: 'Mario Rossi',
          projectName: 'Sito Acme',
          title: 'Logo vettoriale',
          description: 'Serve il logo in formato .ai o .svg.',
          uploadUrl: 'https://calicchia.design/clienti/upload',
        }),
    },
    {
      name: 'report-published',
      fn: () =>
        renderReportPublishedEmail({
          contactName: 'Mario Rossi',
          reportTitle: 'Report SEO Aprile 2026',
          period: 'aprile 2026',
          summary: '+34% traffico organico, top 3 query in posizione 1.',
          reportUrl: 'https://calicchia.design/clienti/report/abc',
        }),
    },
    {
      name: 'quote-invite',
      fn: () =>
        renderQuoteInviteEmail({
          contactName: 'Mario Rossi',
          quoteNumber: 'PREV-2026-001',
          projectScope: 'Sito web + SEO base',
          totalLabel: '€ 4.500,00',
          validUntil: '30 maggio 2026',
          quoteUrl: 'https://calicchia.design/preventivo/abc',
        }),
    },
    {
      name: 'gdpr-request',
      fn: () =>
        renderGdprRequestEmail({
          requestType: 'erasure',
          email: 'someone@example.com',
          fullName: 'Tizio Caio',
          message: 'Vorrei cancellare i miei dati.',
          requestId: 'gdpr-2026-001',
        }),
    },
  ];

  console.log(`Compiling ${tests.length} templates...\n`);
  for (const t of tests) {
    try {
      const result = await t.fn();
      const subject = 'subject' in result ? result.subject : '(no subject)';
      console.log(
        `✓ ${t.name.padEnd(20)} subject="${subject}" html=${result.html.length}b text=${result.text.length}b`
      );
    } catch (e) {
      console.error(`✗ ${t.name}: ${(e as Error).message}`);
    }
  }
  console.log('\nAll templates compiled.');
}

async function sendTestEmail(transport: 'critical' | 'standard', to: string) {
  const isCritical = transport === 'critical';
  const { subject, html, text } = isCritical
    ? await renderMagicLinkEmail({
        contactName: 'Test',
        link: 'https://calicchia.design/clienti/auth/verify?token=test-token-123',
        expiresMinutes: 15,
      })
    : await renderContactFormEmail({
        name: 'Test Standard',
        email: to,
        message: `Smoke test transport=${transport} at ${new Date().toISOString()}.`,
      });

  console.log(`Sending ${transport} email to ${to}...`);
  console.log(`  Subject: ${subject}`);
  console.log(`  HTML: ${html.length} bytes`);
  console.log(`  Text: ${text.length} bytes`);

  const result = await sendEmail({ to, subject, html, text, transport });
  console.log(`\nResult:`, JSON.stringify(result, null, 2));
  if (!result.success) process.exit(1);
}

async function main() {
  const [transport, to] = process.argv.slice(2);
  if (!transport) {
    await compileAllTemplates();
    return;
  }
  if (transport !== 'critical' && transport !== 'standard') {
    console.error(`Bad transport "${transport}". Use "critical" or "standard".`);
    process.exit(1);
  }
  if (!to) {
    console.error('Missing recipient email');
    process.exit(1);
  }
  await sendTestEmail(transport, to);
}

main().catch((e) => {
  console.error('Fatal:', (e as Error).message);
  process.exit(1);
});
