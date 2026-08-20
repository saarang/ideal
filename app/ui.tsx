'use client';
/**
 * Small client helpers used across pages: forms that call server actions and
 * show the result as a toast, plus a confirm wrapper for irreversible steps.
 */
import { useRef, useState, useTransition } from 'react';
import type { ActionResult } from './actions';

let pushToast: ((r: ActionResult) => void) | null = null;

export function Toaster() {
  const [items, setItems] = useState<{ id: number; r: ActionResult }[]>([]);
  pushToast = (r) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, r }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), r.ok ? 4500 : 9000);
  };
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm" role="status" aria-live="polite">
      {items.map(({ id, r }) => (
        <div key={id} className="card card-pad shadow-lg text-sm"
             style={{ borderLeft: `4px solid ${r.ok ? 'var(--good)' : 'var(--bad)'}` }}>
          {r.message}
        </div>
      ))}
    </div>
  );
}

/**
 * A <form> that runs a server action and toasts the ActionResult.
 * Children render as-is; pass hidden inputs for ids.
 */
export function ActionForm({
  action, children, className, confirm, resetOnSuccess,
}: {
  action: (form: FormData) => Promise<ActionResult>;
  children: React.ReactNode;
  className?: string;
  confirm?: string;
  resetOnSuccess?: boolean;
}) {
  const [pending, start] = useTransition();
  const ref = useRef<HTMLFormElement>(null);
  return (
    <form
      ref={ref}
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        if (confirm && !window.confirm(confirm)) return;
        const fd = new FormData(e.currentTarget);
        start(async () => {
          const r = await action(fd);
          pushToast?.(r);
          if (r.ok && resetOnSuccess) ref.current?.reset();
        });
      }}
    >
      <fieldset disabled={pending} className={pending ? 'opacity-60' : ''}>{children}</fieldset>
    </form>
  );
}

/** One-click action button (no visible fields). */
export function ActionButton({
  action, values, children, className = 'btn btn-secondary', confirm,
}: {
  action: (form: FormData) => Promise<ActionResult>;
  values: Record<string, string>;
  children: React.ReactNode;
  className?: string;
  confirm?: string;
}) {
  return (
    <ActionForm action={action} confirm={confirm} className="inline">
      {Object.entries(values).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button type="submit" className={className}>{children}</button>
    </ActionForm>
  );
}

/** Collapsible inline editor (details/summary keeps it dependency-free). */
export function Reveal({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <details className={className}>
      <summary className="cursor-pointer text-sm select-none link inline-block">{label}</summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
