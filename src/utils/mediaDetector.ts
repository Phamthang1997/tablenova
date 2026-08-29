/**
 * Utility functions for detecting and converting various image & media formats in database cells.
 * Supports:
 * 1. Image URLs (http://, https://, //, relative paths, blob:, cloud image CDNs, placeholder services)
 * 2. Base64 Data URIs (data:image/...)
 * 3. Raw Base64 strings with image magic byte signatures (PNG, JPEG, GIF, WEBP, BMP)
 * 4. Hex-encoded binary blobs / Postgres bytea format (\x89504e47...)
 * 5. Node Buffers / Byte arrays / Uint8Array ([137, 80, 78, 71, ...])
 * 6. Inline SVG strings
 */

export interface MediaInfo {
  type: 'image' | 'svg';
  mimeType: string;
  displayUrl: string;
  sourceType: 'url' | 'data-uri' | 'raw-base64' | 'hex-blob' | 'buffer' | 'svg';
  label: string;
  approxByteLength: number;
}

// Common image file extensions
const IMAGE_EXT_REGEX = /\.(png|jpe?g|webp|gif|svg|ico|bmp|avif|tiff?)(\?.*)?$/i;

// Image CDN & Placeholder keyword indicators (for dynamic image URLs without explicit extensions)
const IMAGE_CDN_KEYWORDS = /(picsum|placeholder|unsplash|imgur|cloudinary|gravatar|pravatar|placehold|dummyimage|robohash|loremflickr|pinimg|googleusercontent|fbcdn|twimg|blob\.core\.windows\.net|s3[.-].*\.amazonaws\.com|\.photos|\.images|\.pics|\/images?\/|\/photos?\/|\/avatars?\/|\/uploads?\/|\/assets?\/|\/pictures?\/|\/thumbs?\/|\/icons?\/|\/media\/|\/static\/|\/\d+\/\d+|\/\d+x\d+)/i;

// Column name indicators that strongly suggest image content
const IMAGE_COLUMN_REGEX = /(avatar|image|photo|thumbnail|thumb|picture|logo|banner|cover|poster|icon|screenshot|artwork|img|media|pic|graphic|asset)/i;

// Magic byte signatures for raw base64 detection
const MAGIC_PREFIX_PNG = 'iVBORw0KGgo'; // \x89PNG
const MAGIC_PREFIX_JPEG = '/9j/'; // \xFF\xD8\xFF
const MAGIC_PREFIX_GIF87 = 'R0lGODdh'; // GIF87a
const MAGIC_PREFIX_GIF89 = 'R0lGODlh'; // GIF89a
const MAGIC_PREFIX_WEBP = 'UklGR'; // RIFF....WEBP
const MAGIC_PREFIX_BMP = 'Qk'; // BM

/**
 * Detects whether a cell value represents an image or media, and extracts displayable metadata.
 */
export function detectMedia(value: any, columnName?: string): MediaInfo | null {
  if (value === null || value === undefined) return null;

  // 1. Check Node Buffer or byte array structure { type: 'Buffer', data: [...] } or number[]
  if (typeof value === 'object') {
    let bytes: Uint8Array | null = null;
    if (value instanceof Uint8Array) {
      bytes = value;
    } else if (value.type === 'Buffer' && Array.isArray(value.data)) {
      bytes = new Uint8Array(value.data);
    } else if (Array.isArray(value) && value.length > 8 && typeof value[0] === 'number') {
      bytes = new Uint8Array(value);
    }

    if (bytes && bytes.length >= 8) {
      const hexPrefix = Array.from(bytes.slice(0, 8))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .toLowerCase();

      let mimeType = '';
      let label = 'IMG';

      if (hexPrefix.startsWith('89504e47')) {
        mimeType = 'image/png';
        label = 'PNG';
      } else if (hexPrefix.startsWith('ffd8ff')) {
        mimeType = 'image/jpeg';
        label = 'JPEG';
      } else if (hexPrefix.startsWith('47494638')) {
        mimeType = 'image/gif';
        label = 'GIF';
      } else if (hexPrefix.startsWith('52494646')) {
        mimeType = 'image/webp';
        label = 'WEBP';
      } else if (hexPrefix.startsWith('424d')) {
        mimeType = 'image/bmp';
        label = 'BMP';
      }

      if (mimeType) {
        let binaryStr = '';
        for (let i = 0; i < bytes.length; i++) {
          binaryStr += String.fromCharCode(bytes[i]);
        }
        const dataUrl = `data:${mimeType};base64,${btoa(binaryStr)}`;
        return {
          type: 'image',
          mimeType,
          displayUrl: dataUrl,
          sourceType: 'buffer',
          label,
          approxByteLength: bytes.length,
        };
      }
    }

    return null;
  }

  // Non-strings are not media URLs/data URIs
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed.length < 4) return null;

  // 2. Base64 Data URI format (e.g. data:image/png;base64,...)
  if (trimmed.startsWith('data:image/')) {
    const semiIdx = trimmed.indexOf(';');
    const mimeType = semiIdx > 11 ? trimmed.slice(5, semiIdx) : 'image/png';
    const ext = mimeType.split('/')[1]?.toUpperCase() || 'IMG';
    const approxBytes = Math.round((trimmed.length * 3) / 4);

    return {
      type: 'image',
      mimeType,
      displayUrl: trimmed,
      sourceType: 'data-uri',
      label: ext,
      approxByteLength: approxBytes,
    };
  }

  // 3. HTTP / HTTPS / Protocol-relative / Blob URL
  const isHttpUrl = /^https?:\/\//i.test(trimmed);
  const isProtoRelative = trimmed.startsWith('//');
  const isBlobUrl = trimmed.startsWith('blob:');

  if (isHttpUrl || isProtoRelative || isBlobUrl) {
    const urlClean = isProtoRelative ? `https:${trimmed}` : trimmed;
    const isImageExt = IMAGE_EXT_REGEX.test(urlClean);
    const isImageCdn = IMAGE_CDN_KEYWORDS.test(urlClean);
    const isImageColumn = columnName ? IMAGE_COLUMN_REGEX.test(columnName) : false;

    if (isImageExt || isImageCdn || isImageColumn) {
      let ext = 'IMG';
      const extMatch = urlClean.split('?')[0].match(/\.([a-z0-9]+)$/i);
      if (extMatch) {
        ext = extMatch[1].toUpperCase();
      } else if (urlClean.includes('svg')) {
        ext = 'SVG';
      } else if (urlClean.includes('picsum') || urlClean.includes('photo') || urlClean.includes('jpg') || urlClean.includes('jpeg')) {
        ext = 'JPEG';
      } else if (urlClean.includes('png')) {
        ext = 'PNG';
      } else if (urlClean.includes('webp')) {
        ext = 'WEBP';
      } else if (urlClean.includes('gif')) {
        ext = 'GIF';
      }

      const mimeType = getMimeTypeFromExt(ext);
      return {
        type: ext === 'SVG' ? 'svg' : 'image',
        mimeType,
        displayUrl: urlClean,
        sourceType: 'url',
        label: ext,
        approxByteLength: 0,
      };
    }
  }

  // 4. Relative paths (e.g. /uploads/image.png, images/photo.jpg, ./assets/icon.svg)
  if (
    (trimmed.startsWith('/') || trimmed.startsWith('./') || IMAGE_COLUMN_REGEX.test(columnName || '')) &&
    (IMAGE_EXT_REGEX.test(trimmed) || IMAGE_CDN_KEYWORDS.test(trimmed))
  ) {
    const extMatch = trimmed.split('?')[0].match(/\.([a-z0-9]+)$/i);
    const ext = extMatch ? extMatch[1].toUpperCase() : 'IMG';
    const mimeType = getMimeTypeFromExt(ext);

    return {
      type: ext === 'SVG' ? 'svg' : 'image',
      mimeType,
      displayUrl: trimmed,
      sourceType: 'url',
      label: ext,
      approxByteLength: 0,
    };
  }

  // 5. Hex-encoded Binary Blob / Postgres Bytea format (\x89504e47... or 89504e47...)
  const isPostgresBytea = trimmed.startsWith('\\x') && trimmed.length >= 18;
  const isHexOnly = !isPostgresBytea && /^[0-9a-fA-F]{16,}$/.test(trimmed) && trimmed.length % 2 === 0;

  if (isPostgresBytea || isHexOnly) {
    const rawHex = isPostgresBytea ? trimmed.slice(2) : trimmed;
    const hexPrefix = rawHex.slice(0, 16).toLowerCase();

    if (hexPrefix.startsWith('89504e47')) {
      return {
        type: 'image',
        mimeType: 'image/png',
        displayUrl: hexToDataUrl(rawHex, 'image/png'),
        sourceType: 'hex-blob',
        label: 'PNG',
        approxByteLength: Math.floor(rawHex.length / 2),
      };
    }
    if (hexPrefix.startsWith('ffd8ff')) {
      return {
        type: 'image',
        mimeType: 'image/jpeg',
        displayUrl: hexToDataUrl(rawHex, 'image/jpeg'),
        sourceType: 'hex-blob',
        label: 'JPEG',
        approxByteLength: Math.floor(rawHex.length / 2),
      };
    }
    if (hexPrefix.startsWith('47494638')) {
      return {
        type: 'image',
        mimeType: 'image/gif',
        displayUrl: hexToDataUrl(rawHex, 'image/gif'),
        sourceType: 'hex-blob',
        label: 'GIF',
        approxByteLength: Math.floor(rawHex.length / 2),
      };
    }
    if (hexPrefix.startsWith('52494646')) {
      return {
        type: 'image',
        mimeType: 'image/webp',
        displayUrl: hexToDataUrl(rawHex, 'image/webp'),
        sourceType: 'hex-blob',
        label: 'WEBP',
        approxByteLength: Math.floor(rawHex.length / 2),
      };
    }
    if (hexPrefix.startsWith('424d')) {
      return {
        type: 'image',
        mimeType: 'image/bmp',
        displayUrl: hexToDataUrl(rawHex, 'image/bmp'),
        sourceType: 'hex-blob',
        label: 'BMP',
        approxByteLength: Math.floor(rawHex.length / 2),
      };
    }
  }

  // 6. Raw Base64 string without data: prefix
  const cleanBase64 = trimmed.replace(/\s+/g, '');
  if (cleanBase64.length >= 24) {
    if (cleanBase64.startsWith(MAGIC_PREFIX_PNG)) {
      return {
        type: 'image',
        mimeType: 'image/png',
        displayUrl: `data:image/png;base64,${cleanBase64}`,
        sourceType: 'raw-base64',
        label: 'PNG',
        approxByteLength: Math.round((cleanBase64.length * 3) / 4),
      };
    }
    if (cleanBase64.startsWith(MAGIC_PREFIX_JPEG)) {
      return {
        type: 'image',
        mimeType: 'image/jpeg',
        displayUrl: `data:image/jpeg;base64,${cleanBase64}`,
        sourceType: 'raw-base64',
        label: 'JPEG',
        approxByteLength: Math.round((cleanBase64.length * 3) / 4),
      };
    }
    if (cleanBase64.startsWith(MAGIC_PREFIX_GIF87) || cleanBase64.startsWith(MAGIC_PREFIX_GIF89)) {
      return {
        type: 'image',
        mimeType: 'image/gif',
        displayUrl: `data:image/gif;base64,${cleanBase64}`,
        sourceType: 'raw-base64',
        label: 'GIF',
        approxByteLength: Math.round((cleanBase64.length * 3) / 4),
      };
    }
    if (cleanBase64.startsWith(MAGIC_PREFIX_WEBP)) {
      return {
        type: 'image',
        mimeType: 'image/webp',
        displayUrl: `data:image/webp;base64,${cleanBase64}`,
        sourceType: 'raw-base64',
        label: 'WEBP',
        approxByteLength: Math.round((cleanBase64.length * 3) / 4),
      };
    }
    if (cleanBase64.startsWith(MAGIC_PREFIX_BMP)) {
      return {
        type: 'image',
        mimeType: 'image/bmp',
        displayUrl: `data:image/bmp;base64,${cleanBase64}`,
        sourceType: 'raw-base64',
        label: 'BMP',
        approxByteLength: Math.round((cleanBase64.length * 3) / 4),
      };
    }
  }

  // 7. Raw Inline SVG markup
  if (trimmed.startsWith('<svg') && trimmed.includes('</svg>')) {
    const encodedSvg = encodeURIComponent(trimmed)
      .replace(/'/g, '%27')
      .replace(/"/g, '%22');
    const dataUrl = `data:image/svg+xml;utf8,${encodedSvg}`;

    return {
      type: 'svg',
      mimeType: 'image/svg+xml',
      displayUrl: dataUrl,
      sourceType: 'svg',
      label: 'SVG',
      approxByteLength: trimmed.length,
    };
  }

  return null;
}

/**
 * Converts a hex string to a Base64 data URL.
 */
function hexToDataUrl(hex: string, mimeType: string): string {
  try {
    const binary = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      binary[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    let binaryStr = '';
    for (let i = 0; i < binary.length; i++) {
      binaryStr += String.fromCharCode(binary[i]);
    }
    return `data:${mimeType};base64,${btoa(binaryStr)}`;
  } catch (err) {
    console.error('Failed to convert hex blob to data URL:', err);
    return '';
  }
}

/**
 * Maps common file extensions to MIME types.
 */
function getMimeTypeFromExt(ext: string): string {
  switch (ext.toUpperCase()) {
    case 'PNG': return 'image/png';
    case 'JPG':
    case 'JPEG': return 'image/jpeg';
    case 'WEBP': return 'image/webp';
    case 'GIF': return 'image/gif';
    case 'SVG': return 'image/svg+xml';
    case 'ICO': return 'image/x-icon';
    case 'BMP': return 'image/bmp';
    case 'AVIF': return 'image/avif';
    case 'TIFF':
    case 'TIF': return 'image/tiff';
    default: return 'image/png';
  }
}

/**
 * Formats byte size into human-readable format (B, KB, MB).
 */
export function formatByteSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
