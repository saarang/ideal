'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';

const CAPTIONS = ['', '#bill', '#challan', '#inward', '#ideal_challan', '#order'];

interface SimResult {
  documentId: string | null; refNo: string | null;
  botReplies: string[]; pipeline: { ok: boolean; failedStage?: string; error?: string } | null;
}

export function Simulator({ samples }: { samples: { name: string; path: string }[] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [sample, setSample] = useState(samples[0]?.path ?? '');
  const [caption, setCaption] = useState('');
  const [sender, setSender] = useState('Papa');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SimResult | null>(null);

  async function send() {
    setBusy(true); setError(null); setResult(null);
    try {
      const fd = new FormData();
      const f = fileRef.current?.files?.[0];
      if (f) fd.set('file', f); else if (sample) fd.set('samplePath', sample);
      else { setError('Pick a sample or attach a photo.'); return; }
      fd.set('caption', caption);
      fd.set('sender', sender);
      const res = await fetch('/api/dev/telegram', { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok) { setError(String(json.error ?? `Failed (${res.status})`)); return; }
      setResult(json as SimResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div className="card card-pad grid sm:grid-cols-2 gap-3">
        <div>
          <label className="lbl">Sample paper</label>
          <select className="input" value={sample} onChange={(e) => setSample(e.target.value)}>
            <option value="">— none, I will upload —</option>
            {samples.map((s) => <option key={s.path} value={s.path}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label className="lbl">…or a photo from disk</label>
          <input ref={fileRef} type="file" accept="image/*" className="input" />
        </div>
        <div>
          <label className="lbl">Caption tag (optional)</label>
          <div className="flex gap-2">
            <select className="input !w-40" value={CAPTIONS.includes(caption) ? caption : ''} onChange={(e) => setCaption(e.target.value)}>
              {CAPTIONS.map((c) => <option key={c} value={c}>{c || '— no tag —'}</option>)}
            </select>
            <input className="input" value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="or type a caption" />
          </div>
        </div>
        <div>
          <label className="lbl">Sent by</label>
          <input className="input" value={sender} onChange={(e) => setSender(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <button className="btn btn-primary" disabled={busy} onClick={send}>
            {busy ? 'Sending through the pipeline…' : 'Send as Telegram photo'}
          </button>
        </div>
      </div>

      {error && <p className="text-sm" style={{ color: 'var(--bad)' }}>{error}</p>}

      {result && (
        <div className="card card-pad space-y-2">
          <div className="section-title">What happened</div>
          {result.refNo && (
            <p className="text-sm">
              Saved as <strong>{result.refNo}</strong>
              {result.documentId && <> — <Link className="link" href={`/documents/${result.documentId}`}>open the paper</Link></>}.
            </p>
          )}
          {result.pipeline && (
            <p className="text-sm">
              Reading {result.pipeline.ok ? 'finished' : `stopped at ${result.pipeline.failedStage ?? 'a stage'}`}
              {result.pipeline.error && <span style={{ color: 'var(--warn)' }}> — {result.pipeline.error}</span>}.
            </p>
          )}
          {result.botReplies.length > 0 && (
            <div>
              <p className="text-xs mb-1" style={{ color: 'var(--ink-soft)' }}>Bot replies (as the group would see them):</p>
              <ul className="space-y-1">
                {result.botReplies.map((r, i) => (
                  <li key={i} className="text-sm rounded px-2.5 py-1.5" style={{ background: 'var(--khaki-soft)' }}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
