import { useCallback } from 'react';
import { useNavigate, type NavigateOptions } from 'react-router-dom';
import { localizeAdminPath } from '@/lib/admin-routes';
import { useI18n } from '@/hooks/use-i18n';

export function useLocalizedPath() {
  const { locale } = useI18n();
  return useCallback((path: string) => localizeAdminPath(path, locale), [locale]);
}

export function useLocalizedNavigate() {
  const navigate = useNavigate();
  const { locale } = useI18n();

  return useCallback(
    (path: string, options?: NavigateOptions) => navigate(localizeAdminPath(path, locale), options),
    [locale, navigate],
  );
}
