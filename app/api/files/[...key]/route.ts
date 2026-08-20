/**
 * Streams stored document photos to signed-in users. Files live behind the
 * storage adapter (local disk or object storage) and are never publicly
 * addressable — this route is the only read path.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/src/lib/auth';
import { getStorage } from '@/src/lib/storage';

export const dynamic = 'force-dynamic';

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.heic': 'image/heic', '.pdf': 'application/pdf',
};

export async function GET(_req: NextRequest, ctx: { params: Promise<{ key: string[] }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { key: parts } = await ctx.params;
  const key = parts.map((p) => decodeURIComponent(p)).join('/');
  if (key.includes('..')) return NextResponse.json({ error: 'Bad key' }, { status: 400 });

  try {
    const buffer = await getStorage().get(key);
    const ext = key.slice(key.lastIndexOf('.')).toLowerCase();
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'cache-control': 'private, max-age=3600',
        'content-disposition': `inline; filename="${key.split('/').pop()}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
}
