import { CALENDAR_TZ } from '@/lib/timezone';

const WHEN = new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'short', timeZone: CALENDAR_TZ });

/** `17/10/2026, 09:30` nel fuso del calendario dell'admin. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? WHEN.format(d) : '—';
}

/** Chi ha scritto una versione, dal campo `actor` (device, admin:<id>, mcp, agent, system, sync, rebuild, restore). Non mostra gli identificativi. */
export function actorLabel(actor: string | null): string {
  if (!actor) return 'Sconosciuto';
  const kind = actor.split(':')[0];
  switch (kind) {
    case 'admin': return 'Admin';
    case 'device': return 'Dispositivo';
    case 'mcp': return 'MCP';
    case 'agent': return 'Agente';
    case 'system': return 'Sistema';
    case 'sync': return 'Sincronizzazione';
    case 'rebuild': return 'Ricostruzione dell\'indice';
    case 'restore': return 'Ripristino';
    default: return 'Altro';
  }
}
