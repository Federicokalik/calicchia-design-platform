/**
 * Workflow Trigger Manager
 * Fires workflows based on events, cron, webhooks, etc.
 */

import { sql } from '../../db';
import { executeWorkflow } from './engine';

/**
 * Fire all active workflows that match a specific event type
 */
export async function fireEvent(eventType: string, eventData: any = {}) {
  try {
    const workflows = await sql`
      SELECT id FROM workflows
      WHERE status = 'active'
        AND trigger_type = 'event'
        AND trigger_config->>'event_type' = ${eventType}
    `;

    for (const wf of workflows) {
      console.log(`[Workflow] Firing event "${eventType}" → workflow ${wf.id}`);
      // Execute asynchronously (don't block the event)
      executeWorkflow(wf.id, { event_type: eventType, ...eventData })
        .catch((err) => console.error(`[Workflow] Error executing ${wf.id}:`, err));
    }

    return workflows.length;
  } catch (err) {
    console.error(`[Workflow] Error firing event "${eventType}":`, err);
    return 0;
  }
}

/**
 * Available event types that the system emits
 */
export const WORKFLOW_EVENTS = {
  NUOVO_LEAD: 'nuovo_lead',
  LEAD_CONVERTITO: 'lead_convertito',
  PREVENTIVO_FIRMATO: 'preventivo_firmato',
  PREVENTIVO_INVIATO: 'preventivo_inviato',
  PROGETTO_CREATO: 'progetto_creato',
  TASK_COMPLETATO: 'task_completato',
  PAGAMENTO_RICEVUTO: 'pagamento_ricevuto',
  DOMINIO_SCADENZA: 'dominio_scadenza',
  CONTATTO_RICEVUTO: 'contatto_ricevuto',
  BOOKING_CREATO: 'booking_creato',
} as const;
