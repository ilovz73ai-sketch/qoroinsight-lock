// 본문 암호화 — AES-256-GCM (WebCrypto).
//
// 발행 시 브라우저에서 암호화되어 Arweave에 오르고, 열람 시 브라우저 메모리에서만 풀린다.
// XChaCha20 같은 대안을 쓰지 않는 이유: WebCrypto에 없다. 라이브러리를 들이면 그 라이브러리가
// 곧 공급망이 된다 — 브라우저 내장 프리미티브 하나로 충분한 일이다.
//
// 형식: iv(12바이트) || ciphertext+tag  (GCM 태그 16바이트는 WebCrypto가 암호문 끝에 붙인다)

const IV_BYTES = 12;

/** K_doc — 글마다 새로 뽑는 256비트 키. hex(64자)로 다닌다. */
export function genKdocHex(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/.test(hex)) throw new Error("hexToBytes: hex가 아니다");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function importKey(kDocHex: string, usage: KeyUsage): Promise<CryptoKey> {
  const raw = hexToBytes(kDocHex);
  if (raw.length !== 32) throw new Error("K_doc은 32바이트여야 한다");
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, [usage]);
}

export async function encryptContent(kDocHex: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const key = await importKey(kDocHex, "encrypt");
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plaintext as BufferSource),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out;
}

export async function decryptContent(kDocHex: string, data: Uint8Array): Promise<Uint8Array> {
  if (data.length <= IV_BYTES) throw new Error("암호문이 너무 짧다");
  const iv = data.subarray(0, IV_BYTES);
  const ct = data.subarray(IV_BYTES);
  const key = await importKey(kDocHex, "decrypt");
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ct as BufferSource),
  );
}
