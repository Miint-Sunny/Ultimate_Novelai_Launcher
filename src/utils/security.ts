export const generateSecureUserId = async (token: string): Promise<string> => {
  // Use a partial segment of the token for hashing as requested
  // Skip the "pst-" prefix (first 4 chars) and take the next 24 characters
  // This maintains security while strictly following the "partial content" rule
  const partialContent = token.length > 28 ? token.substring(4, 28) : token;

  // 1. Convert partial content to buffer
  const encoder = new TextEncoder();
  const data = encoder.encode(partialContent);

  // 2. Hash using SHA-256 (One-way encryption)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);

  // 3. Convert buffer to hex string
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  // 4. Take the first 8 characters and uppercase them
  return hashHex.substring(0, 8).toUpperCase();
};
