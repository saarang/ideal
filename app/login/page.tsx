'use client';
import { useActionState } from 'react';
import { loginAction } from '../actions';

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, null);
  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div className="card card-pad w-full max-w-sm">
        <h1 className="text-2xl mb-1">Ideal Uniforms</h1>
        <p className="text-sm mb-5" style={{ color: 'var(--ink-soft)' }}>Stock register — sign in to continue.</p>
        <form action={formAction} className="space-y-3">
          <div>
            <label className="lbl" htmlFor="email">Email</label>
            <input id="email" name="email" type="email" required autoComplete="username" className="input" />
          </div>
          <div>
            <label className="lbl" htmlFor="password">Password</label>
            <input id="password" name="password" type="password" required autoComplete="current-password" className="input" />
          </div>
          {state && !state.ok && <p className="text-sm" style={{ color: 'var(--bad)' }}>{state.message}</p>}
          <button className="btn btn-primary w-full justify-center" disabled={pending}>
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}
