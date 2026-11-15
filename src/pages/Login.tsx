import { useState } from "react";
import { useAction } from "../hooks.tsx";
import { setFakeMoney } from "../lib/api.ts";
import { supabase } from "../lib/supabase.ts";

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const action = useAction();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    action.run(async () => {
      const { error } = await supabase!.auth.signInWithPassword({ email: email.trim(), password });
      // Same message whether the email or the password is wrong.
      if (error) throw new Error("Wrong email or password.");
    });
  };

  return (
    <div className="center">
      <form className="card auth" onSubmit={submit}>
        <h1>Invest</h1>
        <p className="muted">Private app. Accounts are created by invitation only.</p>
        <label>
          Email
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {action.error && <p className="error">{action.error}</p>}
        <button className="primary full" disabled={action.busy}>{action.busy ? "Signing in…" : "Sign in"}</button>
        <button type="button" className="link" onClick={() => setFakeMoney(true)}>
          Or play with fake money — no account needed
        </button>
      </form>
    </div>
  );
}

export function MfaChallenge({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState("");
  const action = useAction();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    action.run(async () => {
      const sb = supabase!;
      const { data: factors, error } = await sb.auth.mfa.listFactors();
      if (error) throw new Error(error.message);
      const factor = factors.totp.find((f) => f.status === "verified");
      if (!factor) throw new Error("No authenticator app is set up for this account.");
      const res = await sb.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.trim() });
      if (res.error) throw new Error("That code is not correct. Try the newest one.");
      onDone();
    });
  };

  return (
    <div className="center">
      <form className="card auth" onSubmit={submit}>
        <h1>Two-factor code</h1>
        <p className="muted">Enter the 6-digit code from your authenticator app.</p>
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          autoFocus
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        {action.error && <p className="error">{action.error}</p>}
        <button className="primary full" disabled={action.busy}>{action.busy ? "Checking…" : "Continue"}</button>
        <button type="button" className="link" onClick={() => supabase!.auth.signOut()}>Sign out</button>
      </form>
    </div>
  );
}
