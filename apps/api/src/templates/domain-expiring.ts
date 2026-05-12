import { esc } from './_compile';
import { renderBrandedEmail } from './_layout';

export interface DomainExpiringInput {
  contactName: string;
  domains: Array<{ name: string; expirationDate: string; daysUntilExpiry: number }>;
  renewUrl: string;
}

function urgencyLabel(days: number): string {
  if (days <= 0) return 'Scaduto';
  if (days <= 7) return 'Urgente';
  if (days <= 14) return 'Importante';
  return 'Avviso';
}

function urgencyColor(days: number): string {
  if (days <= 7) return '#F57F44'; // accent
  if (days <= 14) return '#A66A2A';
  return '#5C5C58';
}

export function renderDomainExpiringEmail(input: DomainExpiringInput) {
  const mostUrgent = Math.min(...input.domains.map((d) => d.daysUntilExpiry));
  const urgencyText = mostUrgent <= 0 ? 'Dominio scaduto' : `${mostUrgent} giorni alla scadenza`;
  const subject =
    mostUrgent <= 7
      ? `URGENTE — ${input.domains.length === 1 ? '1 dominio' : `${input.domains.length} domini`} in scadenza`
      : `${input.domains.length === 1 ? '1 dominio' : `${input.domains.length} domini`} in scadenza`;

  const introText =
    input.domains.length === 1
      ? 'Il tuo dominio sta per scadere. Rinnovalo per evitare interruzioni.'
      : `${input.domains.length} dei tuoi domini stanno per scadere. Rinnoveli per evitare interruzioni.`;

  const rows = input.domains
    .map((d) => {
      const dayLabel = d.daysUntilExpiry <= 0 ? 'Scaduto' : `${d.daysUntilExpiry}g`;
      return `<tr style="border-bottom:1px solid #E6E4DC;">
        <td style="padding:10px 0;font-weight:500;">${esc(d.name)}</td>
        <td style="padding:10px 0;text-align:center;color:#5C5C58;font-size:13px;">${esc(d.expirationDate)}</td>
        <td style="padding:10px 0;text-align:right;color:${urgencyColor(d.daysUntilExpiry)};font-weight:500;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;">${dayLabel}</td>
      </tr>`;
    })
    .join('');

  const sections = `
    <mj-section padding="0 24px">
      <mj-column mj-class="card">
        <mj-text mj-class="eyebrow" color="${urgencyColor(mostUrgent)}">${urgencyLabel(mostUrgent)} · ${esc(urgencyText)}</mj-text>
        <mj-text mj-class="display" padding-top="4px">${esc(input.domains.length === 1 ? 'Dominio in scadenza' : 'Domini in scadenza')}</mj-text>
        <mj-text padding-top="12px">Ciao ${esc(input.contactName)},</mj-text>
        <mj-text padding-top="6px">${esc(introText)}</mj-text>
        <mj-divider border-color="#E6E4DC" border-width="1px" padding="16px 0" />
        <mj-table>
          <tr>
            <th style="padding:6px 0;text-align:left;color:#8C8C86;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:500;">Dominio</th>
            <th style="padding:6px 0;text-align:center;color:#8C8C86;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:500;">Scadenza</th>
            <th style="padding:6px 0;text-align:right;color:#8C8C86;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:500;">Giorni</th>
          </tr>
          ${rows}
        </mj-table>
        <mj-button href="${esc(input.renewUrl)}" padding-top="24px" align="left">Contattaci per il rinnovo</mj-button>
        <mj-text mj-class="muted" padding-top="16px">
          Mantieni attivo il dominio per evitare downtime, perdita di brand e blocco delle email associate.
        </mj-text>
      </mj-column>
    </mj-section>
  `;

  return renderBrandedEmail({
    preview: urgencyText,
    title: subject,
    sectionsMjml: sections,
    lang: 'it',
  }).then((compiled) => ({ subject, ...compiled }));
}
