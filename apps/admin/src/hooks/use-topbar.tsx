import { createContext, useContext, useState, useEffect, useRef, type ReactNode } from 'react';

interface TopbarState {
  title: string;
  subtitle: string;
  actions: ReactNode | null;
}

interface TopbarContextType {
  state: TopbarState;
  setState: React.Dispatch<React.SetStateAction<TopbarState>>;
}

const DEFAULT_STATE: TopbarState = { title: 'Dashboard', subtitle: '', actions: null };

const TopbarContext = createContext<TopbarContextType>({
  state: DEFAULT_STATE,
  setState: () => {},
});

export function TopbarProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TopbarState>(DEFAULT_STATE);

  return (
    <TopbarContext.Provider value={{ state, setState }}>
      {children}
    </TopbarContext.Provider>
  );
}

/**
 * Hook for pages to set topbar content.
 * Call in the page component — auto-cleans on unmount.
 */
export function useTopbar(config: { title: string; subtitle?: string; actions?: ReactNode }) {
  const { setState } = useContext(TopbarContext);

  // `actions` may be inline JSX (new reference each render). We must NOT
  // include it in deps — would cause an infinite setState loop. Pages that
  // need actions to react to mutation state should memoize them with useMemo.
  const actionsRef = useRef<ReactNode>(config.actions ?? null);
  actionsRef.current = config.actions ?? null;

  useEffect(() => {
    setState({
      title: config.title,
      subtitle: config.subtitle || '',
      actions: actionsRef.current,
    });
  }, [config.title, config.subtitle, setState]);

  // Reset to defaults only when the consuming page unmounts.
  useEffect(() => {
    return () => setState(DEFAULT_STATE);
  }, [setState]);
}

export function useTopbarState() {
  return useContext(TopbarContext).state;
}
