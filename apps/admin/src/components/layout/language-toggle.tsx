import { Languages } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n } from '@/hooks/use-i18n';
import { apiFetch } from '@/lib/api';
import type { AdminLocale } from '@/lib/i18n-storage';
import { localizeAdminPath } from '@/lib/admin-routes';

export function LanguageToggle() {
  const { locale, setLocale, t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();

  const changeLocale = async (next: AdminLocale) => {
    const current = `${location.pathname}${location.search}${location.hash}`;
    setLocale(next);
    const nextPath = localizeAdminPath(current, next);
    if (nextPath !== current) navigate(nextPath, { replace: true });
    try {
      await apiFetch('/api/auth/me/locale', {
        method: 'PATCH',
        body: JSON.stringify({ locale: next }),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Errore');
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-xs uppercase text-muted-foreground"
          title={t('app.language')}
          aria-label={t('app.language')}
        >
          <Languages className="mr-1.5 h-3.5 w-3.5" />
          {locale}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => changeLocale('it')}>
          {t('app.language.it')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => changeLocale('en')}>
          {t('app.language.en')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
