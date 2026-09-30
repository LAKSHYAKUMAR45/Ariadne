import { describe, expect, it } from 'vitest';
import { MediaIngestor, type MediaAdapter } from '../../../src/knowledge/formats/MediaIngestor.js';

describe('optional media ingestion', () => {
  it('returns unsupported instead of silently producing empty text', async () => {
    const result = await new MediaIngestor().extract({
      path: 'screen.png',
      content: '',
      mimeType: 'image/png',
      metadata: { source: 'capture' },
    });

    expect(result).toMatchObject({
      status: 'unsupported',
      format: 'image',
      metadata: { source: 'capture' },
    });
  });

  it('preserves media references and metadata from an optional adapter', async () => {
    const adapter: MediaAdapter = {
      format: 'image',
      supports: () => true,
      extract: async (input) => ({
        text: 'A diagram',
        normalizedText: 'A diagram',
        metadata: { model: 'ocr' },
        spans: [],
        headings: [],
        links: [],
        provenance: [{ kind: 'file', id: input.path ?? 'unknown', path: input.path }],
        mediaRefs: [{ kind: 'image', uri: input.path ?? 'unknown', mimeType: input.mimeType }],
      }),
    };

    const result = await new MediaIngestor({ adapters: [adapter] }).extract({
      path: 'screen.png',
      content: '',
      mimeType: 'image/png',
      metadata: { source: 'capture' },
      mediaRefs: [{ kind: 'image', uri: 'screen.png', mimeType: 'image/png' }],
    });

    expect(result).toMatchObject({
      text: 'A diagram',
      metadata: { source: 'capture', model: 'ocr' },
      mediaRefs: [{ uri: 'screen.png', mimeType: 'image/png' }],
    });
  });

  it('returns a typed failure when a media adapter throws', async () => {
    const adapter: MediaAdapter = {
      format: 'audio',
      supports: () => true,
      extract: async () => {
        throw new Error('transcriber failed');
      },
    };

    await expect(
      new MediaIngestor({ adapters: [adapter] }).extract({
        path: 'meeting.mp3',
        content: '',
        metadata: { speaker: 'team' },
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      code: 'parser_failed',
      error: 'transcriber failed',
      metadata: { speaker: 'team' },
    });
  });
});
