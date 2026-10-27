import { describe, it, expect } from 'vitest';
import {
  parseDriveImageUrl,
  buildDriveViewUrl,
  extractDriveImageFileIds,
  isAcceptedImageType,
  isWithinSizeCap,
  buildUploadFilename,
  buildUploadingToken,
  replaceUploadingToken,
  reconcileTokenInText,
  removeDriveImageMarkdown,
} from '../noteImages.js';

describe('parseDriveImageUrl', () => {
  it('parses a canonical Drive file-view URL', () => {
    expect(
      parseDriveImageUrl('https://drive.google.com/file/d/ABC-123_x/view'),
    ).toEqual({ fileId: 'ABC-123_x' });
  });

  it('still matches with a ?usp=sharing suffix', () => {
    expect(
      parseDriveImageUrl(
        'https://drive.google.com/file/d/ABC-123_x/view?usp=sharing',
      ),
    ).toEqual({ fileId: 'ABC-123_x' });
  });

  it('returns null for a non-Drive URL', () => {
    expect(parseDriveImageUrl('https://example.com/x.png')).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parseDriveImageUrl(undefined)).toBeNull();
  });
});

describe('buildDriveViewUrl', () => {
  it('round-trips through parseDriveImageUrl', () => {
    expect(parseDriveImageUrl(buildDriveViewUrl('X'))).toEqual({ fileId: 'X' });
  });
});

describe('extractDriveImageFileIds', () => {
  it('extracts deduped, order-preserving Drive file ids from markdown images', () => {
    const text =
      'a ![p](https://drive.google.com/file/d/A/view) b ![q](https://drive.google.com/file/d/B/view) ![again](https://drive.google.com/file/d/A/view)';
    expect(extractDriveImageFileIds(text)).toEqual(['A', 'B']);
  });

  it('returns [] for text with no images', () => {
    expect(extractDriveImageFileIds('just some plain text')).toEqual([]);
  });

  it('excludes non-Drive image URLs', () => {
    expect(
      extractDriveImageFileIds('![x](https://example.com/x.png)'),
    ).toEqual([]);
  });
});

describe('isAcceptedImageType', () => {
  it('accepts png/jpeg/gif/webp', () => {
    expect(isAcceptedImageType('image/png')).toBe(true);
    expect(isAcceptedImageType('image/jpeg')).toBe(true);
    expect(isAcceptedImageType('image/gif')).toBe(true);
    expect(isAcceptedImageType('image/webp')).toBe(true);
  });

  it('rejects svg/bmp/text', () => {
    expect(isAcceptedImageType('image/svg+xml')).toBe(false);
    expect(isAcceptedImageType('image/bmp')).toBe(false);
    expect(isAcceptedImageType('text/plain')).toBe(false);
  });
});

describe('isWithinSizeCap', () => {
  it('accepts exactly the 5 MiB cap', () => {
    expect(isWithinSizeCap(5 * 1024 * 1024)).toBe(true);
  });

  it('rejects one byte over the cap', () => {
    expect(isWithinSizeCap(5 * 1024 * 1024 + 1)).toBe(false);
  });
});

describe('buildUploadFilename', () => {
  it('slugifies the base name and drops the extension', () => {
    expect(buildUploadFilename('My Photo.PNG', 'image/png')).toMatch(
      /^my-photo-[a-z0-9]{6}\.png$/,
    );
  });

  it('falls back to image-<rand> when name is missing', () => {
    expect(buildUploadFilename(undefined, 'image/jpeg')).toMatch(
      /^image-[a-z0-9]{6}\.jpg$/,
    );
  });

  it('falls back to image-<rand> when name slugifies to nothing', () => {
    expect(buildUploadFilename('  ***  ', 'image/png')).toMatch(
      /^image-[a-z0-9]{6}\.png$/,
    );
  });
});

describe('buildUploadingToken', () => {
  it('builds the placeholder markdown token', () => {
    expect(buildUploadingToken('cat', 'ab12cd')).toBe(
      '![cat](uploading:ab12cd)',
    );
  });
});

describe('replaceUploadingToken', () => {
  const token = buildUploadingToken('cat', 'ab12cd');
  const replacement = '![cat](https://drive.google.com/file/d/Z/view)';

  it('swaps exactly once and returns correct from/to', () => {
    const doc = `before ${token} after`;
    const result = replaceUploadingToken(doc, token, replacement);
    expect(result).toEqual({
      doc: `before ${replacement} after`,
      from: 'before '.length,
      to: 'before '.length + token.length,
    });
  });

  it('returns null when the token is absent', () => {
    expect(replaceUploadingToken('no token here', token, replacement)).toBeNull();
  });

  it('returns null when the token occurs more than once', () => {
    const doc = `${token} and again ${token}`;
    expect(replaceUploadingToken(doc, token, replacement)).toBeNull();
  });
});

describe('reconcileTokenInText', () => {
  const token = buildUploadingToken('c', 'ab12cd');
  const resolved = '![c](https://drive.google.com/file/d/Z/view)';

  it('replaces the inline token with the resolved image', () => {
    expect(reconcileTokenInText(`x ${token} y`, token, resolved)).toBe(
      `x ${resolved} y`,
    );
  });

  it('removes the inline token when replacement is null', () => {
    const out = reconcileTokenInText(`x ${token} y`, token, null);
    expect(out).toBe('x  y');
    expect(out).not.toContain('uploading:');
  });

  it('collapses a lone image line to nothing when replacement is null', () => {
    const out = reconcileTokenInText(`${token}\n`, token, null);
    expect(out).toBe('');
    expect(out).not.toContain('uploading:');
  });

  it('returns the text byte-identical when the token is absent', () => {
    const text = 'x ![c](uploading:zzzzzz) y';
    expect(reconcileTokenInText(text, token, resolved)).toBe(text);
  });
});

describe('removeDriveImageMarkdown', () => {
  it('removes a single matching image occurrence', () => {
    expect(
      removeDriveImageMarkdown(`![a](${buildDriveViewUrl('B')})\ntext`, 'B'),
    ).toBe('text');
  });

  it('removes only the target image, keeping other distinct images', () => {
    const out = removeDriveImageMarkdown(
      `![a](${buildDriveViewUrl('A')}) ![b](${buildDriveViewUrl('B')})`,
      'B',
    );
    expect(out).toContain(`![a](${buildDriveViewUrl('A')})`);
    expect(out).not.toContain(buildDriveViewUrl('B'));
  });

  it('removes every occurrence of a duplicated fileId', () => {
    const out = removeDriveImageMarkdown(
      `![a](${buildDriveViewUrl('B')}) mid ![b](${buildDriveViewUrl('B')})`,
      'B',
    );
    expect(out).not.toContain(buildDriveViewUrl('B'));
  });

  it('returns the input byte-identical when the fileId is absent', () => {
    const input = `head ![a](${buildDriveViewUrl('B')}) tail`;
    const out = removeDriveImageMarkdown(input, 'ZZZ');
    expect(out).toBe(input);
    expect(Object.is(out, input)).toBe(true);
  });

  it('collapses image-only text to an empty string', () => {
    expect(removeDriveImageMarkdown(`![a](${buildDriveViewUrl('B')})`, 'B')).toBe(
      '',
    );
  });

  it('cleans up surrounding-prose blank lines', () => {
    expect(
      removeDriveImageMarkdown(
        `line1\n\n![a](${buildDriveViewUrl('B')})\n\nline2`,
        'B',
      ),
    ).toBe('line1\n\nline2');
  });

  it('leaves a bare (non-markdown) Drive URL untouched', () => {
    const input = `see ${buildDriveViewUrl('B')} here`;
    expect(removeDriveImageMarkdown(input, 'B')).toBe(input);
  });

  it('collapses trailing whitespace left before the removed image', () => {
    expect(
      removeDriveImageMarkdown(`word   \n![a](${buildDriveViewUrl('B')})`, 'B'),
    ).toBe('word');
  });
});
