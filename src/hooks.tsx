import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { errorText } from "./lib/format.ts";
import type { Env } from "./lib/types.ts";

export interface Async<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Runs an async loader, optionally re-running it every `pollMs` while the tab is visible. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], pollMs?: number): Async<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    setData(undefined);
    setLoading(true);
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    const run = () =>
      fnRef.current().then(
        (d) => alive && (setData(d), setError(null), setLoading(false)),
        (e) => alive && (setError(errorText(e)), setLoading(false)),
      );
    run();
    const id = pollMs ? setInterval(() => !document.hidden && run(), pollMs) : undefined;
    return () => {
      alive = false;
      if (id) clearInterval(id);
    };
  }, [...deps, tick, pollMs]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

export interface EnvCtx {
  env: Env;
  setEnv: (e: Env) => void;
  broker: { paper: boolean; live: boolean } | undefined;
  reloadBroker: () => void;
}
export const EnvContext = createContext<EnvCtx>({
  env: "paper",
  setEnv: () => {},
  broker: undefined,
  reloadBroker: () => {},
});
export const useEnv = () => useContext(EnvContext);

/** Wraps an action button: tracks busy state and surfaces the error text. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clear: () => setError(null) };
}
