import fs from 'fs/promises';
import path from 'path';
import { notFound } from 'next/navigation';
import { Simulator } from './simulator';

export const dynamic = 'force-dynamic';

export default async function DevTelegramPage() {
  if (process.env.DEV_TOOLS !== '1') notFound();

  let samples: { name: string; path: string }[] = [];
  try {
    const dir = path.resolve('./samples');
    const files = await fs.readdir(dir);
    samples = files.filter((f) => /\.(jpe?g|png)$/i.test(f)).map((f) => ({ name: f, path: path.join(dir, f) }));
  } catch { /* no samples yet */ }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl">Telegram simulator</h1>
        <p className="text-sm max-w-2xl" style={{ color: 'var(--ink-soft)' }}>
          Dev tool: send a photo through the exact same path a real Telegram message takes — download, ingest,
          reading, checks — without a bot. Pick a generated sample (run <span className="qty">npm run seed:demo</span> to
          create them) or upload any photo. Only works with TELEGRAM_MODE=mock.
        </p>
      </header>
      <Simulator samples={samples} />
    </div>
  );
}
