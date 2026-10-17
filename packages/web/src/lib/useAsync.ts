import { useEffect, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
}

/** The state plus `retry`, which runs `factory` again for the same key. */
export type AsyncResult<T> = AsyncState<T> & { retry: () => void };

/** Runs `factory` when `key` changes; ignores stale resolutions. */
export function useAsync<T>(key: string, factory: () => Promise<T>): AsyncResult<T> {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    error: null,
    loading: true,
  });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    factory().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (error: unknown) =>
        live &&
        setState({
          data: null,
          error: error instanceof Error ? error : new Error(String(error)),
          loading: false,
        }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);
  return { ...state, retry: () => setAttempt((n) => n + 1) };
}
