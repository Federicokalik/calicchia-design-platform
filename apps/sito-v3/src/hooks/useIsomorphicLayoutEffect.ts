import { useEffect, useLayoutEffect } from 'react';

/**
 * useLayoutEffect on the client, no-op during SSR.
 * Prevents the React warning when a client-only effect lives in shared code.
 */
export const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;
