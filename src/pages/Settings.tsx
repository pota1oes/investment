import { useState } from "react";
import { useAction, useAsync, useEnv } from "../hooks.tsx";
import { api, hasBackend, isDemo, setFakeMoney } from "../lib/api.ts";
import { resetDemo } from "../lib/demo.ts";
import { supabase } from "../lib/supabase.ts";
import type { Env } from "../lib/types.ts";

function BrokerCard({ env, connected, canConnect }: { env: Env; connected: boolean; canConnect: boolean }) {
  const { reloadBroker } = useEnv();
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const action = useAction();
  const live = env === "live";

  return (
    <div className="card">
      <div className="card-head">
        <h3>{live ? "Alpaca live account (real money)" : "Alpaca paper account (practice money)"}</h3>
        <span className={`badge ${connected ? "ok" : ""}`}>{connected ? "Connected" : "Not connected"}</span>
      </div>
      {connected
        ? (
          <>
            <p className="muted">
              Keys are stored encrypted on the server and are never sent back to this browser.
            </p>
            <button
              className="danger"
              disabled={action.busy}
              onClick={() => action.run(() => api.disconnectBroker(env).then(reloadBroker))}
            >
              Disconnect and delete keys
            </button>
          </>
        )
        : !canConnect
        ? <p className="muted">Turn on two-factor authentication below and sign in again before adding real-money keys.</p>
        : (
          <form
            className="form"
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault();
              action.run(async () => {
                await api.connectBroker(env, keyId, secret);
                setKeyId("");
                setSecret("");
                reloadBroker();
              });
            }}
          >
            <p className="muted">
              In the Alpaca dashboard, open the {live ? "live" : "paper"} account and generate API keys, then paste
              them here. You type these in yourself; they go straight to your server over an encrypted connection.
            </p>
            <label>
              API key ID
              <input value={keyId} onChange={(e) => setKeyId(e.target.value)} required spellCheck={false} />
            </label>
            <label>
              Secret key
              <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} required />
            </label>
            <button className="primary" disabled={action.busy}>{action.busy ? "Checking keys…" : "Connect"}</button>
          </form>
        )}
      {action.error && <p className="error">{action.error}</p>}
    </div>
  );
}

function TwoFactor({ onChange }: { onChange: () => void }) {
  const sb = supabase!;
  const factors = useAsync(async () => {
    const { data, error } = await sb.auth.mfa.listFactors();
    if (error) throw new Error(error.message);
    return data.totp;
  }, []);
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const action = useAction();
  const active = factors.data?.find((f) => f.status === "verified");

  const start = () =>
    action.run(async () => {
      // Remove half-finished attempts so a fresh QR code can be issued.
      for (const f of factors.data ?? []) {
        if (f.status !== "verified") await sb.auth.mfa.unenroll({ factorId: f.id });
      }
      const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: `app-${Date.now()}` });
      if (error) throw new Error(error.message);
      setEnroll({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    });

  const verify = (e: React.FormEvent) => {
    e.preventDefault();
    action.run(async () => {
      const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: enroll!.id, code: code.trim() });
      if (error) throw new Error("That code is not correct. Try the newest one.");
      setEnroll(null);
      setCode("");
      factors.reload();
      onChange();
    });
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3>Two-factor authentication</h3>
        <span className={`badge ${active ? "ok" : ""}`}>{active ? "On" : "Off"}</span>
      </div>
      <p className="muted">
        Adds a 6-digit code from an authenticator app at sign-in. Required for anything that touches real money.
      </p>
      {active && (
        <button
          className="danger"
          disabled={action.busy}
          onClick={() =>
            action.run(async () => {
              const { error } = await sb.auth.mfa.unenroll({ factorId: active.id });
              if (error) throw new Error(error.message);
              factors.reload();
              onChange();
            })}
        >
          Turn off
        </button>
      )}
      {!active && !enroll && <button className="primary" disabled={action.busy || !factors.data} onClick={start}>Set up</button>}
      {enroll && (
        <form className="form" onSubmit={verify}>
          <p>Scan this with your authenticator app, then enter the code it shows.</p>
          <img className="qr" src={enroll.qr} alt="Two-factor QR code" width={180} height={180} />
          <p className="muted">Can't scan? Enter this key manually: <code>{enroll.secret}</code></p>
          <label>
            6-digit code
            <input inputMode="numeric" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <button className="primary" disabled={action.busy}>Turn on</button>
        </form>
      )}
      {(action.error || factors.error) && <p className="error">{action.error ?? factors.error}</p>}
    </div>
  );
}

function Password() {
  const [pw, setPw] = useState("");
  const [done, setDone] = useState(false);
  const action = useAction();
  return (
    <div className="card">
      <h3>Password</h3>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          setDone(false);
          action.run(async () => {
            if (pw.length < 12) throw new Error("Use at least 12 characters.");
            const { error } = await supabase!.auth.updateUser({ password: pw });
            if (error) throw new Error(error.message);
            setPw("");
            setDone(true);
          });
        }}
      >
        <label>
          New password
          <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required />
        </label>
        <button disabled={action.busy}>Change password</button>
        {action.error && <p className="error">{action.error}</p>}
        {done && <p className="ok">Password changed.</p>}
      </form>
    </div>
  );
}

export function Settings() {
  const { broker } = useEnv();
  const aal = useAsync(async () => {
    if (!supabase) return "aal1";
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    return data?.currentLevel ?? "aal1";
  }, []);

  if (isDemo) {
    return (
      <>
        <h1>Settings</h1>
        <div className="card">
          <h3>Fake-money mode</h3>
          <p className="muted">
            You are playing with $100,000 of pretend money on simulated prices. Everything stays in this browser
            and nothing here can touch a real account.{" "}
            {hasBackend
              ? "Switch to your real account to manage brokerage connections and security."
              : "Logins, brokerage connections and two-factor authentication appear here once Supabase is connected — the README walks through it."}
          </p>
          {hasBackend && (
            <p>
              <button className="primary" onClick={() => setFakeMoney(false)}>Switch to your real account</button>
            </p>
          )}
          <button
            className="danger"
            onClick={() => {
              resetDemo();
              location.reload();
            }}
          >
            Reset fake money to $100,000
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Settings</h1>
      <h2>Brokerage</h2>
      <BrokerCard env="paper" connected={!!broker?.paper} canConnect />
      <BrokerCard env="live" connected={!!broker?.live} canConnect={aal.data === "aal2"} />
      <h2>Security</h2>
      <TwoFactor onChange={aal.reload} />
      <Password />
      <div className="card">
        <h3>Session</h3>
        <button onClick={() => supabase!.auth.signOut()}>Sign out</button>
      </div>
    </>
  );
}
