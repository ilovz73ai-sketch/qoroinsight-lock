// 잠금 파일(.qlock) — 외부 잠금 페이지가 만들고 insight 발행 화면이 받는 단 하나의 인계 형식 (AGENTS.md 43).
//
// 왜 파일인가: 잠금 페이지는 네트워크를 못 쓴다(CSP `connect-src 'none'` — 평문이 어디로도 못 간다는 것을 코드를 안 읽고도
// 브라우저가 보장한다). 그래서 결과를 사람이 들고 와야 하는데, 본문 암호문만 100 KiB 라 URL 로는 크기가 안 맞는다.
//
// 이 파일에 들어 있는 것은 **공개해도 되는 것뿐이다**: 제목·미리보기(어차피 공개된다) · 암호문 · drand 잠금 · 지문들.
// 복호화 키(K_doc)는 **없다** — 그 키는 잠금(sealedKdoc) 안에만 있고 공개일의 drand 서명으로만 풀린다. 그래서 이 파일을
// 받은 insight 서버도 공개일 전에는 못 연다(판매 안 함 글 — AGENTS.md 42). 이 사실이 이 기능의 전부다.
//
// ⚠ 이 파일은 외부 잠금 페이지 저장소로 **글자 그대로 복사된다**(scripts/export-open.mjs). 두 쪽이 같은 검사를 해야 잠금 페이지가
//   "통과"라고 한 파일을 insight 가 거부하지 않는다. 브라우저 전용 API·React·서버 모듈을 import 하지 마라.
// ⚠ 형식 이름(`qoro-insight-lock/v1`)과 필드를 바꾸지 마라 — 이미 내려받은 파일이 못 읽힌다. 바꿔야 하면 v2 를 **더해라**.

import { roundAfterTime } from "./drand";
import { POST_ID_RE } from "./ids";
import { sealedRoundOf } from "./tlock";

export const LOCK_FORMAT = "qoro-insight-lock/v1" as const;

/**
 * 한도 — 서버(schema.ts)와 **같은 값**이어야 한다. schema.ts 를 import 하지 않는 이유는 zod 를 잠금 페이지에 싣지 않으려고다
 * (그 페이지는 작고 읽기 쉬워야 검증할 수 있다). 같은지는 lockFile.test.ts 가 대조한다.
 */
export const LOCK_LIMITS = {
  titleMax: 120,
  previewMax: 1000,
  /** 암호문 한 덩어리(본문·이미지 각각)의 상한 — Arweave Turbo 무료 구간. */
  cipherMaxBytes: 100 * 1024,
  imagesMax: 8,
  sealMaxChars: 8192,
  openDateMinMs: 5 * 24 * 60 * 60 * 1000,
  openDateMaxMs: 1097 * 24 * 60 * 60 * 1000,
} as const;

/** AES-GCM 이 붙이는 바이트(iv 12 + tag 16) — 평문 한도 = 암호문 한도 − 이것(contentCrypto.ts 형식). */
export const GCM_OVERHEAD_BYTES = 28;

export type LockBlob = {
  /** 암호문(base64) — contentCrypto.ts 의 iv ‖ ciphertext+tag. */
  cipher: string;
  /** 암호문의 sha256 — 업로드 응답의 ciphertextSha256 과 같아야 하고, 이미지는 본문이 이 값으로 가리킨다. */
  sha256: string;
  bytes: number;
};

export type LockFileV1 = {
  format: typeof LOCK_FORMAT;
  postId: string;
  /** 공개 — 원장·목록에 실린다. 잠긴 본문 안에도 같은 제목이 들어 있다. */
  title: string;
  /** 공개 — 무료 미리보기. */
  preview: string;
  openDateMs: number;
  /** 공개일 이후 첫 drand 라운드(roundAfterTime) — 잠금 헤더의 라운드와 같아야 한다. */
  round: number;
  /** 평문 본문의 sha256 — 원장에 각인되고, 공개일에 공개기가 연 본문과 대조한다(opener.ts). */
  contentSha256: string;
  body: LockBlob;
  /** 본문이 `qrimg://cipher-<sha256>` 으로 가리키는 이미지 암호문들(postBody.ts). */
  images: LockBlob[];
  /** K_doc 을 공개일 라운드에 잠근 age armor(tlock.ts 형식). */
  sealedKdoc: string;
  /** 어느 잠금 페이지 빌드가 만들었는가 — 정보용(검사는 안 한다). */
  sealer: { commit: string };
  madeAtMs: number;
};

export type LockFileProblem =
  | "not_json"
  | "bad_format"
  | "bad_post_id"
  | "bad_title"
  | "bad_preview"
  | "bad_open_date"
  | "open_date_too_soon"
  | "open_date_too_far"
  | "round_mismatch"
  | "bad_seal"
  | "seal_round_mismatch"
  | "bad_content_hash"
  | "bad_body"
  | "body_too_large"
  | "body_hash_mismatch"
  | "too_many_images"
  | "bad_image"
  | "image_too_large"
  | "image_hash_mismatch";

export type ParsedLockFile = { file: LockFileV1; body: Uint8Array; images: Uint8Array[] };

const HEX64_RE = /^[0-9a-f]{64}$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000; // 한 번에 다 펼치면 큰 배열에서 호출 스택이 넘친다
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array | null {
  if (typeof b64 !== "string" || b64.length % 4 !== 0 || !B64_RE.test(b64)) return null;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function trimmedLength(v: unknown): number {
  return typeof v === "string" ? v.trim().length : -1;
}

/**
 * 공개일 창 — 서버(posts.ts createPost)와 같은 식이다(시계 오차 1시간은 봐준다). 잠금 페이지는 잠그기 전에, 발행 화면은 올리기
 * 전에 본다: 둘 다 서버가 결국 거부할 파일을 업로드가 끝난 **뒤에** 거부당하지 않게 하려는 것이다.
 */
export function openDateProblem(openDateMs: number, nowMs: number): "bad_open_date" | "open_date_too_soon" | "open_date_too_far" | null {
  if (!Number.isSafeInteger(openDateMs) || openDateMs <= 0) return "bad_open_date";
  if (openDateMs < nowMs + LOCK_LIMITS.openDateMinMs - 3_600_000) return "open_date_too_soon";
  if (openDateMs > nowMs + LOCK_LIMITS.openDateMaxMs) return "open_date_too_far";
  return null;
}

async function checkBlob(
  v: unknown,
  problems: { bad: LockFileProblem; big: LockFileProblem; hash: LockFileProblem },
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; problem: LockFileProblem }> {
  const b = v as Partial<LockBlob> | null;
  if (typeof b !== "object" || b === null || typeof b.cipher !== "string" || typeof b.sha256 !== "string" || !HEX64_RE.test(b.sha256)) {
    return { ok: false, problem: problems.bad };
  }
  const bytes = base64ToBytes(b.cipher);
  if (!bytes || bytes.length <= GCM_OVERHEAD_BYTES || b.bytes !== bytes.length) return { ok: false, problem: problems.bad };
  if (bytes.length > LOCK_LIMITS.cipherMaxBytes) return { ok: false, problem: problems.big };
  if ((await sha256Hex(bytes)) !== b.sha256) return { ok: false, problem: problems.hash };
  return { ok: true, bytes };
}

/**
 * 잠금 파일을 읽고 **전부** 확인한다 — 형식 · 한도 · 공개일 창 · 라운드 재유도 · 잠금 헤더의 실제 라운드 · 암호문 지문.
 * 확인할 수 없는 것은 하나뿐이다: 잠금 안의 키가 이 본문을 여는가(공개일 전에는 아무도 모른다). 그건 공개일에 공개기가 본문을
 * 복호해 contentSha256 과 대조해서 확인하고, 틀리면 그 글은 열리지 않은 채 마감에 파기된다(AGENTS.md 42).
 */
export async function parseLockFile(text: string, nowMs: number): Promise<{ ok: true; parsed: ParsedLockFile } | { ok: false; problem: LockFileProblem }> {
  let v: Partial<LockFileV1>;
  try {
    v = JSON.parse(text) as Partial<LockFileV1>;
  } catch {
    return { ok: false, problem: "not_json" };
  }
  if (typeof v !== "object" || v === null || v.format !== LOCK_FORMAT) return { ok: false, problem: "bad_format" };
  if (typeof v.postId !== "string" || !POST_ID_RE.test(v.postId)) return { ok: false, problem: "bad_post_id" };
  const tl = trimmedLength(v.title);
  if (tl < 1 || tl > LOCK_LIMITS.titleMax) return { ok: false, problem: "bad_title" };
  const pl = trimmedLength(v.preview);
  if (pl < 1 || pl > LOCK_LIMITS.previewMax) return { ok: false, problem: "bad_preview" };
  const dateProblem = openDateProblem(v.openDateMs as number, nowMs);
  if (dateProblem) return { ok: false, problem: dateProblem };
  if (v.round !== roundAfterTime(v.openDateMs as number)) return { ok: false, problem: "round_mismatch" };
  if (typeof v.sealedKdoc !== "string" || v.sealedKdoc.length === 0 || v.sealedKdoc.length > LOCK_LIMITS.sealMaxChars) {
    return { ok: false, problem: "bad_seal" };
  }
  // 더 늦은 라운드로 잠근 잠금은 공개일 **연기**다 — 판매 안 함 글은 잠금이 유일한 키라서다(AGENTS.md 42 · posts.ts).
  if (sealedRoundOf(v.sealedKdoc) !== v.round) return { ok: false, problem: "seal_round_mismatch" };
  if (typeof v.contentSha256 !== "string" || !HEX64_RE.test(v.contentSha256)) return { ok: false, problem: "bad_content_hash" };

  const body = await checkBlob(v.body, { bad: "bad_body", big: "body_too_large", hash: "body_hash_mismatch" });
  if (!body.ok) return body;
  if (!Array.isArray(v.images)) return { ok: false, problem: "bad_image" };
  if (v.images.length > LOCK_LIMITS.imagesMax) return { ok: false, problem: "too_many_images" };
  const images: Uint8Array[] = [];
  const seen = new Set<string>();
  for (const img of v.images) {
    const r = await checkBlob(img, { bad: "bad_image", big: "image_too_large", hash: "image_hash_mismatch" });
    if (!r.ok) return r;
    // 같은 그림 두 장은 한 번만 싣는다(잠금 페이지가 그렇게 만든다) — 겹치면 업로드가 헛돈다.
    if (seen.has((img as LockBlob).sha256)) return { ok: false, problem: "bad_image" };
    seen.add((img as LockBlob).sha256);
    images.push(r.bytes);
  }

  const file: LockFileV1 = {
    format: LOCK_FORMAT,
    postId: v.postId,
    title: (v.title as string).trim(),
    preview: (v.preview as string).trim(),
    openDateMs: v.openDateMs as number,
    round: v.round,
    contentSha256: v.contentSha256,
    body: v.body as LockBlob,
    images: v.images as LockBlob[],
    sealedKdoc: v.sealedKdoc,
    sealer: { commit: typeof v.sealer?.commit === "string" ? v.sealer.commit : "unknown" },
    madeAtMs: typeof v.madeAtMs === "number" ? v.madeAtMs : 0,
  };
  return { ok: true, parsed: { file, body: body.bytes, images } };
}

/** 문제 코드 → 사람이 읽는 문장(두 언어). 잠금 페이지와 발행 화면이 같은 문장을 쓴다. */
export function lockProblemText(p: LockFileProblem): { ko: string; en: string } {
  const T: Record<LockFileProblem, { ko: string; en: string }> = {
    not_json: { ko: "잠금 파일이 아닙니다(JSON 이 아닙니다).", en: "This isn't a lock file (not JSON)." },
    bad_format: { ko: "qoro insight 잠금 파일이 아닙니다.", en: "This isn't a qoro insight lock file." },
    bad_post_id: { ko: "글 id 가 올바르지 않습니다.", en: "The post id isn't valid." },
    bad_title: { ko: `제목은 1~${LOCK_LIMITS.titleMax}자여야 합니다.`, en: `The title must be 1–${LOCK_LIMITS.titleMax} characters.` },
    bad_preview: {
      ko: `미리보기는 1~${LOCK_LIMITS.previewMax}자여야 합니다.`,
      en: `The preview must be 1–${LOCK_LIMITS.previewMax} characters.`,
    },
    bad_open_date: { ko: "공개일이 올바르지 않습니다.", en: "The open date isn't valid." },
    open_date_too_soon: {
      ko: "공개일이 너무 가깝습니다 — 최소 5일 뒤여야 합니다. 잠금 페이지에서 다시 잠가 주세요.",
      en: "The open date is too soon — it must be at least 5 days away. Please lock it again on the lock page.",
    },
    open_date_too_far: { ko: "공개일은 최대 3년 뒤까지입니다.", en: "The open date can be at most 3 years away." },
    round_mismatch: { ko: "공개일과 drand 라운드가 맞지 않습니다.", en: "The open date and the drand round don't match." },
    bad_seal: { ko: "잠금(sealedKdoc)이 올바르지 않습니다.", en: "The lock (sealedKdoc) isn't valid." },
    seal_round_mismatch: {
      ko: "잠금이 공개일의 라운드로 걸려 있지 않습니다.",
      en: "The lock isn't set to the open date's round.",
    },
    bad_content_hash: { ko: "본문 지문이 올바르지 않습니다.", en: "The body fingerprint isn't valid." },
    bad_body: { ko: "본문 암호문이 올바르지 않습니다.", en: "The body ciphertext isn't valid." },
    body_too_large: { ko: "본문이 100 KiB 를 넘습니다.", en: "The body is over 100 KiB." },
    body_hash_mismatch: { ko: "본문 암호문이 지문과 다릅니다 — 파일이 손상됐습니다.", en: "The body ciphertext doesn't match its fingerprint — the file is damaged." },
    too_many_images: { ko: `이미지는 최대 ${LOCK_LIMITS.imagesMax}장입니다.`, en: `At most ${LOCK_LIMITS.imagesMax} images are allowed.` },
    bad_image: { ko: "이미지 암호문이 올바르지 않습니다.", en: "An image ciphertext isn't valid." },
    image_too_large: { ko: "이미지 하나가 100 KiB 를 넘습니다.", en: "An image is over 100 KiB." },
    image_hash_mismatch: {
      ko: "이미지 암호문이 지문과 다릅니다 — 파일이 손상됐습니다.",
      en: "An image ciphertext doesn't match its fingerprint — the file is damaged.",
    },
  };
  return T[p];
}
