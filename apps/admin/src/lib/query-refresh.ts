import type { QueryClient } from '@tanstack/react-query';

/**
 * Segna come stale tutte le query e rifà il fetch di quelle a schermo, tranne
 * quelle con `meta: { skipGlobalRefetch: true }` (fetch costosi o con effetti
 * esterni). Usato dopo ogni mutation riuscita (MutationCache in main.tsx) e
 * dalle scritture che non passano da useMutation (azioni dell'assistente AI).
 */
export function refreshAllQueries(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ predicate: (query) => !query.meta?.skipGlobalRefetch });
}
