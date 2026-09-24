import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Returns a callback with a stable identity that always invokes the latest
 * version of `callback`. Panels use this for host-provided handlers so data
 * loading effects do not re-run (and re-request from the bridge) whenever the
 * parent re-renders with new callback identities.
 */
export function useStableCallback<TArgs extends unknown[], TResult>(
  callback: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  const callbackRef = useRef(callback);

  useLayoutEffect(() => {
    callbackRef.current = callback;
  });

  return useCallback((...args: TArgs) => callbackRef.current(...args), []);
}
