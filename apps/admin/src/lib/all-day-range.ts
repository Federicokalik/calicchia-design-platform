/**
 * Inizio e fine di un evento "tutto il giorno" dal form (pages/calendario/
 * evento-edit.tsx). Modulo senza React per poterlo verificare con uno script.
 */
import { addDaysToDate, zonedDateToIso } from './timezone';

/**
 * Inizio e fine di un evento "tutto il giorno": mezzanotte di Roma del giorno
 * d'inizio e fine esclusiva a mezzanotte di Roma. Una fine sul confine del
 * giorno dopo l'inizio resta quella; altrimenti vale fino alla fine del giorno
 * indicato. Il confine del giorno è mezzanotte di Roma (00:00) oppure
 * mezzanotte UTC letta nel fuso di Roma (01:00 in CET, 02:00 in CEST): gli
 * all-day salvati dal vecchio admin (selezione di un giorno nella vista mese) e
 * quelli creati via MCP o agente hanno la fine a mezzanotte UTC, che il form
 * mostra alle 01:00 o 02:00 e che non va trattata come fine inclusiva.
 */
export function allDayRange(startInput: string, endInput: string): { start_time: string; end_time: string } {
  const startDay = startInput.slice(0, 10);
  const endDay = endInput.slice(0, 10);
  const endTime = endInput.slice(11, 16);
  const endAtDayBoundary = endTime === '00:00' || endTime === '01:00' || endTime === '02:00';
  const exclusiveEnd = endDay > startDay && endAtDayBoundary ? endDay : addDaysToDate(endDay > startDay ? endDay : startDay, 1);
  return { start_time: zonedDateToIso(startDay), end_time: zonedDateToIso(exclusiveEnd) };
}
