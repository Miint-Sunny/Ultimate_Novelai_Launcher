const hashBufferToHex = (hashBuffer: ArrayBuffer): string => {
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
};

const simpleHash = (str: string): string => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  const hash1 = Math.abs(hash).toString(16).padStart(8, '0');
  let hash2 = 0;
  for (let i = 0; i < str.length; i += 2) {
    const char = str.charCodeAt(i);
    hash2 = ((hash2 << 3) - hash2) + char;
    hash2 = hash2 & hash2;
  }
  const hash2Str = Math.abs(hash2).toString(16).padStart(8, '0');
  const timestamp = Date.now().toString(16);
  const random = Math.random().toString(16).slice(2, 10);
  return `${hash1}${hash2Str}${timestamp}${random}`.slice(0, 64).padEnd(64, '0');
};

export const safeSha256 = async (data: BufferSource | string): Promise<string> => {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const buffer = typeof data === 'string'
        ? new TextEncoder().encode(data)
        : data;
      const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
      return hashBufferToHex(hashBuffer);
    } catch (e) {
      console.warn('crypto.subtle.digest failed, using fallback:', e);
    }
  }

  const str = typeof data === 'string'
    ? data
    : btoa(String.fromCharCode(...new Uint8Array(data as ArrayBuffer)));
  return simpleHash(str);
};

export const computeVibeEncodingHash = async (informationExtracted: number): Promise<string> => {
  const input = `information_extracted:${informationExtracted}`;
  return safeSha256(input);
};

export const computeNaiVibeId = async (imageBase64: string): Promise<string> => {
  return safeSha256(imageBase64);
};

export const computeEncodingHash = async (encodingBase64: string): Promise<string> => {
  const binaryString = atob(encodingBase64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return safeSha256(bytes);
};

export const computeVibeIdFromImage = async (imageBase64: string): Promise<string> => {
  return safeSha256(imageBase64);
};
