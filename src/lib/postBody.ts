// 본문 형식 — 암호화되기 전 평문 JSON의 규약.
//
// v1: { v: 1, title, body }          — 생 텍스트(초기 발행분). 문단 나눠 렌더한다.
// v2: { v: 2, title, format: "quill-delta", ops } — Quill 델타. 이미지는 데이터가 아니라
//     **참조**로 들어간다: src = "qrimg://<arweaveTx>?sha256=<평문지문>&type=<mime>".
//     이미지 바이트는 같은 K_doc으로 암호화돼 별도 Arweave 업로드로 실린다.
//
// 왜 참조인가: 본문 암호문은 100KiB 무료 구간이 상한이다. 이미지를 본문에 인라인하면 사진 한
// 장으로 끝난다. 참조로 빼면 장당 100KiB를 따로 쓰고, 참조 문자열에 평문 sha256이 들어 있어
// 본문의 contentSha256이 이미지 무결성까지 덮는다 — 검증 경로가 공짜로 따라온다.
//
// ⚠ 렌더링은 이 모듈이 돌려준 델타를 **Quill 읽기 전용 인스턴스**로만 그린다.
//   dangerouslySetInnerHTML 금지 — 본문은 작성자가 만든 값이고, 독자의 세션·지갑 승인이
//   같은 오리진에 산다. HTML 문자열 경로를 하나라도 열면 그게 XSS의 입구다.

export type PostBodyV1 = { v: 1; title: string; body: string };

/** Quill 델타 op — 우리가 다루는 최소 형태(전체 타입은 quill-delta 것을 쓰지 않는다:
 *  복호화된 JSON은 신뢰할 수 없는 입력이라 어차피 형태 검사를 우리 손으로 해야 한다). */
export type DeltaOp = {
  insert?: string | { image?: string; video?: string; [k: string]: unknown };
  attributes?: Record<string, unknown>;
};

export type PostBodyV2 = { v: 2; title: string; format: "quill-delta"; ops: DeltaOp[] };

export type PostBody = PostBodyV1 | PostBodyV2;

/** 복호화된 평문 JSON → 본문. 형태가 어긋나면 null(렌더러가 "손상됨"을 말하게 한다). */
export function parsePostBody(json: unknown): PostBody | null {
  if (typeof json !== "object" || json === null) return null;
  const b = json as Record<string, unknown>;
  if (typeof b.title !== "string") return null;
  if (b.v === 1 && typeof b.body === "string") {
    return { v: 1, title: b.title, body: b.body };
  }
  if (b.v === 2 && b.format === "quill-delta" && Array.isArray(b.ops)) {
    return { v: 2, title: b.title, format: "quill-delta", ops: b.ops as DeltaOp[] };
  }
  return null;
}

export function encodePostBodyV2(title: string, ops: DeltaOp[]): PostBodyV2 {
  return { v: 2, title, format: "quill-delta", ops };
}

// ── qrimg 참조 ───────────────────────────────────────────────────────────────

const ARWEAVE_TX_RE = /^[A-Za-z0-9_-]{43}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
/** 이미지 mime 허용 목록 — 렌더 시 Blob type으로 그대로 쓰이므로 화이트리스트다.
 *  imageCompress.ts IMAGE_MIME_ALLOWED와 같아야 한다(어긋나면 영구히 못 여는 이미지가 봉인된다). */
const IMAGE_MIME_RE = /^image\/(jpeg|png|webp|gif|avif)$/;

/**
 * 이미지 참조. 둘 중 하나로 이미지를 가리킨다:
 *  · `tx` — Arweave tx id(앱의 발행 화면). 업로드가 먼저고 본문이 그 뒤라 tx 를 안다.
 *  · `cipherSha256` — **암호문의 sha256**(외부 잠금 페이지, AGENTS.md 43). 그 페이지는 네트워크를 못 쓰므로 tx 를 모른 채
 *    본문을 잠근다. 화면은 매니페스트의 이미지 목록 `[{ tx, sha256: 암호문 sha256 }]` 에서 tx 를 찾는다 — 매니페스트가
 *    원래 그 대응을 들고 있었다(발행 때 업로드 응답의 ciphertextSha256 이 그 값이다).
 * 어느 쪽이든 `sha256` 은 **평문** 지문이고, 본문의 contentSha256 이 그것까지 덮는다(이 파일 머리말).
 * ⚠ 형식 문자열을 바꾸지 마라 — 잠긴 본문 안에 들어가 Arweave 에 영원히 남는다. 새 형식은 갈래를 **더해서** 만든다.
 */
export type QrimgRef =
  | { tx: string; cipherSha256?: undefined; sha256: string; mime: string }
  | { tx: null; cipherSha256: string; sha256: string; mime: string };

const CIPHER_PREFIX = "cipher-";

export function buildQrimgSrc(ref: QrimgRef): string {
  const target = ref.tx ?? `${CIPHER_PREFIX}${ref.cipherSha256}`;
  return `qrimg://${target}?sha256=${ref.sha256}&type=${encodeURIComponent(ref.mime)}`;
}

export function parseQrimgSrc(src: unknown): QrimgRef | null {
  if (typeof src !== "string" || !src.startsWith("qrimg://")) return null;
  const rest = src.slice("qrimg://".length);
  const q = rest.indexOf("?");
  if (q < 0) return null;
  const target = rest.slice(0, q);
  const params = new URLSearchParams(rest.slice(q + 1));
  const sha256 = params.get("sha256") ?? "";
  const mime = params.get("type") ?? "";
  if (!HEX64_RE.test(sha256) || !IMAGE_MIME_RE.test(mime)) return null;
  if (target.startsWith(CIPHER_PREFIX)) {
    const cipherSha256 = target.slice(CIPHER_PREFIX.length);
    return HEX64_RE.test(cipherSha256) ? { tx: null, cipherSha256, sha256, mime } : null;
  }
  if (!ARWEAVE_TX_RE.test(target)) return null;
  return { tx: target, sha256, mime };
}

/**
 * 매니페스트(그 글이 선언한 보관 목록)에서 "암호문 sha256 → tx" 대응을 뽑는다 — 암호문 지문 참조를 푸는 재료.
 * ⚠ 매니페스트 파서(lib/arweave/manifest.ts)를 쓰지 않는 이유: 그 파일이 drand(tlock-js)를 물고 있어 열람 화면의 초기 JS 가
 *   그만큼 무거워진다(AGENTS.md 27). 여기서 필요한 것은 images 목록 하나뿐이고, 형태는 이 함수가 직접 확인한다.
 * 형태가 어긋난 항목은 버린다 — 그 이미지는 "찾을 수 없음"으로 실패하고, 나머지 이미지는 그대로 열린다.
 */
export function cipherTxMapFromManifest(json: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const images = typeof json === "object" && json !== null ? (json as { images?: unknown }).images : undefined;
  if (!Array.isArray(images)) return out;
  for (const img of images) {
    const tx = (img as { tx?: unknown })?.tx;
    const sha = (img as { sha256?: unknown })?.sha256;
    if (typeof tx === "string" && ARWEAVE_TX_RE.test(tx) && typeof sha === "string" && HEX64_RE.test(sha)) out.set(sha, tx);
  }
  return out;
}

/** 델타 안의 qrimg 참조 전부(발행 시 매니페스트 목록·렌더 시 프리페치 목록). */
export function extractQrimgRefs(ops: DeltaOp[]): QrimgRef[] {
  const out: QrimgRef[] = [];
  for (const op of ops) {
    if (typeof op.insert === "object" && op.insert !== null) {
      const ref = parseQrimgSrc((op.insert as { image?: unknown }).image);
      if (ref) out.push(ref);
    }
  }
  return out;
}

/**
 * qrimg 참조 한 개의 길이. 이미지 한 장이 **본문 평문에서** 차지하는 크기가 이것이다 —
 * 에디터가 들고 있는 데이터 URI(수십~수백 KiB)가 아니다.
 */
export const QRIMG_SRC_LEN = buildQrimgSrc({
  tx: "A".repeat(43),
  sha256: "0".repeat(64),
  mime: "image/jpeg",
}).length;

/** 암호문 지문 참조(외부 잠금 페이지)의 길이 — tx 참조보다 길다(64자 + 접두어). 그 페이지의 잔량 표시가 쓴다. */
export const QRIMG_CIPHER_SRC_LEN = buildQrimgSrc({
  tx: null,
  cipherSha256: "0".repeat(64),
  sha256: "0".repeat(64),
  mime: "image/jpeg",
}).length;

/**
 * 발행 때 암호화될 평문의 바이트 수. **발행 전에** 100KiB 상한까지 얼마나 남았는지 말해 주고,
 * 발행 직전에는 업로드를 시작하기 전에 막는 데 쓴다.
 *
 * ⚠ 데이터 URI를 그대로 재면 안 된다. 발행 때 qrimg 참조로 **바뀐 뒤** 암호화되므로, 안 바꾸고
 *   재면 사진 한 장에 "상한 초과"라는 거짓 경고가 뜬다. 같은 길이의 자리표시자로 바꿔 잰다
 *   (참조 문자열에는 JSON 이스케이프가 필요한 문자가 없어 길이가 곧 바이트다).
 * ⚠ **화면의 잔량 표시와 발행 직전의 게이트가 이 함수 하나여야 한다.** 두 벌로 적으면 화면이
 *   "아직 여유 있다"고 말한 뒤 발행이 거부되는 상태가 생긴다 — 이 저장소가 가장 싫어하는 모양이다.
 */
export function estimateBodyBytes(title: string, ops: DeltaOp[], refLen: number = QRIMG_SRC_LEN): number {
  const placeholder = "A".repeat(refLen);
  const resolved = ops.map((op) => {
    if (typeof op.insert === "object" && op.insert !== null) {
      const src = (op.insert as { image?: unknown }).image;
      if (typeof src === "string" && src.startsWith("data:")) {
        return { ...op, insert: { ...op.insert, image: placeholder } };
      }
    }
    return op;
  });
  return new TextEncoder().encode(JSON.stringify(encodePostBodyV2(title, resolved))).length;
}

// ── 유튜브 임베드 ───────────────────────────────────────────────────────────
//
// 왜 이것만 예외인가: 한때 이 파일의 화이트리스트 주석이 "video(iframe) 같은 임베드는 넣지
// 않는다"고 못 박고 있었다. 그 판단의 근거는 **작성자가 준 URL이 독자의 오리진에서 프레임으로
// 뜬다**는 것이었고, 그건 지금도 맞다. 그래서 URL을 받지 않는다 — **11자 영상 id만** 받는다.
//
//   ① 에디터가 붙여 넣은 주소에서 id를 뽑는다(youtubeIdFromUrl).
//   ② 델타에는 **우리가 지은** 주소만 들어간다(buildYoutubeEmbedSrc).
//   ③ 렌더 직전에 **다시** id를 뽑아 **다시** 우리가 짓는다(QuillViewer).
//
// ③이 사족처럼 보이지만 아니다: 원장·Arweave에 이미 실린 옛 글의 델타는 고칠 수 없는 입력이고,
// 이 앱은 그런 입력을 신뢰하지 않는 것으로 서 있다. ②만 있으면 오늘의 코드가 옳다는 뜻이지
// 어제 실린 바이트가 옳다는 뜻이 아니다.
//
// ⚠ **이 정규식을 느슨하게 만들지 마라.** `youtube-nocookie.com` 고정 · 경로 `/embed/` 고정 ·
//   id 11자 고정이다. 하나라도 열면 작성자가 임의 주소를 프레임으로 띄울 수 있고, 그건
//   dangerouslySetInnerHTML을 막아 놓은 이 파일의 존재 이유를 뒷문으로 되돌리는 것이다.
// ⚠ nocookie 도메인인 이유는 추적이다 — 재생을 누르기 전에는 쿠키가 붙지 않는다. 이미지에서
//   http(s) src를 막은 것(QuillViewer 머리말: 추적 픽셀)과 같은 자리의 판단이다.

const YOUTUBE_EMBED_RE =
  /^https:\/\/www\.youtube-nocookie\.com\/embed\/([A-Za-z0-9_-]{11})$/;

/** 영상 id → 우리가 쓰는 유일한 임베드 주소. */
export function buildYoutubeEmbedSrc(id: string): string {
  return `https://www.youtube-nocookie.com/embed/${id}`;
}

/** 델타에 담긴 임베드 주소 → 영상 id. 형태가 조금이라도 다르면 null이다. */
export function parseYoutubeEmbedSrc(src: unknown): string | null {
  if (typeof src !== "string") return null;
  const m = YOUTUBE_EMBED_RE.exec(src);
  return m ? m[1] : null;
}

/**
 * 사람이 붙여 넣는 온갖 유튜브 주소 → 영상 id. 유튜브가 아니면 null.
 *
 * 받아 주는 형태: `youtu.be/<id>` · `youtube.com/watch?v=<id>` · `/embed/<id>` · `/shorts/<id>`
 * · `/live/<id>` (모바일 `m.` 과 `youtube-nocookie.com` 포함). `?si=`·`?t=` 같은 꼬리는 버린다 —
 * 우리가 짓는 주소에 그것을 실어 주면 그게 곧 작성자가 통제하는 쿼리스트링이 된다.
 */
export function youtubeIdFromUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.replace(/^(www|m)\./, "");
  const id =
    host === "youtu.be"
      ? u.pathname.slice(1)
      : host === "youtube.com" || host === "youtube-nocookie.com"
        ? (u.searchParams.get("v") ??
          /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(u.pathname)?.[1] ??
          "")
        : "";
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** 델타의 텍스트만 이어붙인다 — 글자수 안내용. */
export function deltaText(ops: DeltaOp[]): string {
  return ops.map((op) => (typeof op.insert === "string" ? op.insert : "")).join("");
}
