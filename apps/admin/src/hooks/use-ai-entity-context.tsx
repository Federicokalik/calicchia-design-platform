import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export interface AiEntityContext {
  kind: 'progetto' | 'cliente' | 'lead' | 'preventivo' | 'fattura' | 'task' | 'email';
  id: string;
  title: string;
  summary?: string;
}

interface Ctx {
  entity: AiEntityContext | null;
  setEntity: (v: AiEntityContext | null) => void;
}

const AiEntityContextCtx = createContext<Ctx | null>(null);

export function AiEntityContextProvider({ children }: { children: ReactNode }) {
  const [entity, setEntity] = useState<AiEntityContext | null>(null);
  const value = useMemo(() => ({ entity, setEntity }), [entity]);
  return <AiEntityContextCtx.Provider value={value}>{children}</AiEntityContextCtx.Provider>;
}

export function useAiEntityContext(): AiEntityContext | null {
  const ctx = useContext(AiEntityContextCtx);
  return ctx?.entity ?? null;
}

/**
 * Set the current AI entity context. Call this from a detail page on mount.
 * Pass null to clear. Cleared automatically on unmount.
 */
export function useSetAiEntityContext(entity: AiEntityContext | null) {
  const ctx = useContext(AiEntityContextCtx);
  const setter = ctx?.setEntity;
  const serialized = entity ? `${entity.kind}|${entity.id}|${entity.title}|${entity.summary ?? ''}` : '';

  useEffect(() => {
    if (!setter) return;
    setter(entity);
    return () => setter(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized, setter]);
}

export function useClearAiEntityContext() {
  const ctx = useContext(AiEntityContextCtx);
  return useCallback(() => ctx?.setEntity(null), [ctx]);
}
