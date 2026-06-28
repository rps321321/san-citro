// Media protocol: san-citro-media://<md5>/<chapter_id>
//
// Streams a single audiobook chapter to the <audio> element in the player view.
// The md5 is the URL host, the chapter_id is the URL pathname. The handler asks
// the Python bridge for a realpath-contained absolute path (get_chapter_path);
// a null result is a 404. HTTP Range requests are honoured so <audio> seeking
// works (stream:true is set on the privileged scheme in main.ts).

import fs from 'fs';
import { protocol } from 'electron';
import type { PythonBridge } from './python-bridge';

export interface RangeResult {
  status: 200 | 206 | 416;
  start: number;
  end: number;
}

/**
 * Parse a single HTTP byte-range against a known resource size.
 *
 * Pure + synchronous so it can be unit-tested in isolation. Supports the three
 * forms <audio> actually issues:
 *   - no header              -> 200, full body (start=0, end=size-1)
 *   - "bytes=0-99"           -> 206, start=0 end=99
 *   - "bytes=100-"           -> 206, start=100 end=size-1
 *   - "bytes=-500"           -> 206, suffix: last 500 bytes
 * Anything unsatisfiable (start >= size) or malformed -> 416.
 * `end` is inclusive (HTTP semantics); for a 200 with size 0, end is -1.
 */
export function parseRange(
  rangeHeader: string | null | undefined,
  size: number,
): RangeResult {
  if (!rangeHeader) {
    return { status: 200, start: 0, end: size - 1 };
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    return { status: 416, start: 0, end: size - 1 };
  }

  const startStr = match[1];
  const endStr = match[2];

  // Both empty ("bytes=-") is malformed.
  if (startStr === '' && endStr === '') {
    return { status: 416, start: 0, end: size - 1 };
  }

  let start: number;
  let end: number;

  if (startStr === '') {
    // Suffix range: "bytes=-N" -> last N bytes.
    const suffixLen = parseInt(endStr, 10);
    if (suffixLen <= 0) {
      return { status: 416, start: 0, end: size - 1 };
    }
    start = Math.max(0, size - suffixLen);
    end = size - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === '' ? size - 1 : parseInt(endStr, 10);
    // Clamp the end to the last valid byte.
    if (end > size - 1) {
      end = size - 1;
    }
  }

  // Unsatisfiable: start past the end of the resource, or inverted range.
  if (start >= size || start > end) {
    return { status: 416, start: 0, end: size - 1 };
  }

  return { status: 206, start, end };
}

const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4b': 'audio/mp4',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
};

function contentTypeForPath(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** Bridge a Node Readable stream into a web ReadableStream for a Response body. */
function nodeStreamToWeb(nodeStream: fs.ReadStream): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on('data', (chunk: string | Buffer) => {
        controller.enqueue(
          typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk),
        );
      });
      nodeStream.on('end', () => {
        controller.close();
      });
      nodeStream.on('error', (err) => {
        // Tear down the web stream so the renderer sees a failed body rather
        // than a hang. Destroy the node side too (belt-and-suspenders).
        try {
          controller.error(err);
        } catch {
          /* already closed */
        }
        nodeStream.destroy();
      });
    },
    cancel() {
      nodeStream.destroy();
    },
  });
}

/**
 * Register the san-citro-media:// protocol handler. The scheme itself is
 * declared privileged (with stream:true) in main.ts before app-ready.
 */
export function registerMediaProtocol(bridge: PythonBridge): void {
  protocol.handle('san-citro-media', async (request) => {
    const url = new URL(request.url);
    // host = md5, pathname = "/<chapter_id>"
    const md5 = url.hostname;
    const chapterIdRaw = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const chapterId = Number.parseInt(chapterIdRaw, 10);

    if (!md5 || !Number.isInteger(chapterId)) {
      return new Response('Bad request', { status: 400 });
    }

    let filePath: string | null;
    try {
      filePath = (await bridge.call('get_chapter_path', {
        md5,
        chapter_id: chapterId,
      })) as string | null;
    } catch (err) {
      console.error('[media-protocol] get_chapter_path failed:', err);
      return new Response('Not found', { status: 404 });
    }

    if (!filePath) {
      return new Response('Not found', { status: 404 });
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return new Response('Not found', { status: 404 });
    }

    const size = stat.size;
    const contentType = contentTypeForPath(filePath);
    const rangeHeader = request.headers.get('range');
    const range = parseRange(rangeHeader, size);

    if (range.status === 416) {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      });
    }

    if (range.status === 206) {
      const length = range.end - range.start + 1;
      const nodeStream = fs.createReadStream(filePath, {
        start: range.start,
        end: range.end,
      });
      return new Response(nodeStreamToWeb(nodeStream), {
        status: 206,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(length),
          'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }

    // 200 — full body.
    const nodeStream = fs.createReadStream(filePath);
    return new Response(nodeStreamToWeb(nodeStream), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
      },
    });
  });
}
