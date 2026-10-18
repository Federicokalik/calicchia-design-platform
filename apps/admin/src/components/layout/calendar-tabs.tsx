import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/use-i18n';
import { useLocalizedPath } from '@/hooks/use-localized-navigation';
import { useCalendarV2Capabilities } from '@/lib/calendar-v2-api';

/**
 * Sotto-nav per la sezione Calendario. Sostituisce le 4 voci figlie che prima
 * vivevano nella sidebar — ora la sidebar mostra solo "Calendario" e le sezioni
 * granulari sono tab dentro la pagina, allineate al pattern Bierut/Pentagram di
 * minimal hairlines.
 */
const TABS: Array<{ labelKey: string; path: string; end?: boolean; requires?: 'trash' | 'health_page' }> = [
  { labelKey: 'nav.calendar', path: '/calendario', end: true },
  { labelKey: 'nav.calendar.calendars', path: '/calendario/calendari' },
  { labelKey: 'nav.calendar.bookings', path: '/calendario/prenotazioni' },
  { labelKey: 'nav.calendar.availability', path: '/calendario/disponibilita' },
  { labelKey: 'nav.calendar.eventTypes', path: '/calendario/event-types' },
  // Strumento di migrazione a Radicale (F3): wizard a 6 passi.
  { labelKey: 'nav.calendar.migration', path: '/calendario/migrazione' },
  // Cestino degli eventi eliminati (F6): solo se l'API v2 dichiara la capacità `trash`.
  { labelKey: 'nav.calendar.trash', path: '/calendario/cestino', requires: 'trash' },
  // Salute della sincronizzazione con Radicale (F6): solo con la capacità `health_page`.
  { labelKey: 'nav.calendar.health', path: '/calendario/salute', requires: 'health_page' },
];

export function CalendarTabs() {
  const { t } = useI18n();
  const localizedPath = useLocalizedPath();
  const { caps } = useCalendarV2Capabilities();
  const tabs = TABS.filter((tab) => !tab.requires || caps?.[tab.requires] === true);

  return (
    <div className="border-b -mx-1 mb-4">
      <nav className="flex gap-1 overflow-x-auto scrollbar-auto px-1" aria-label="Sezioni calendario">
        {tabs.map((tab) => (
          <NavLink
            key={tab.path}
            to={localizedPath(tab.path)}
            end={tab.end}
            className={({ isActive }) =>
              cn(
                'shrink-0 px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px',
                isActive
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )
            }
          >
            {t(tab.labelKey)}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
