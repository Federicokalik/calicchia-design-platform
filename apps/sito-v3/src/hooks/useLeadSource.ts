'use client';

import { useSearchParams } from 'next/navigation';

export function useLeadSource(): {
  source: string | null;
  service: string | null;
  isAudit: boolean;
} {
  const params = useSearchParams();
  const source = params?.get('lead') ?? null;

  if (!source) {
    return { source: null, service: null, isAudit: false };
  }

  if (source.startsWith('audit-')) {
    return {
      source,
      service: source.slice('audit-'.length) || null,
      isAudit: true,
    };
  }

  return { source, service: null, isAudit: false };
}
