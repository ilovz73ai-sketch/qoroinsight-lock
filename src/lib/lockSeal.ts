// 잠금 파일 만들기 — 외부 잠금 페이지(AGENTS.md 43)가 부르는 단 하나의 함수.
//
// 평문(제목·본문·이미지)이 들어와서 공개해도 되는 것(lockFile.ts LockFileV1)만 나간다. 그 사이에서:
//   ① 글 id 와 K_doc 을 새로 뽑는다(앱의 발행 화면과 같은 함수 — ids.ts · contentCrypto.ts).
//   ② 이미지마다 평문 지문 → 암호화 → 암호문 지문. 본문은 이미지를 `qrimg://cipher-<암호문 지문>` 으로 가리킨다(postBody.ts) —
//      tx 는 업로드해야 생기는데 이 페이지는 네트워크를 못 쓰기 때문이다.
//   ③ 본문 평문(encodePostBodyV2) → 지문(contentSha256, 원장에 각인된다) → 암호화.
//   ④ K_doc 을 공개일 라운드에 **오프라인으로** 잠근다(tlockOffline.ts). 그 뒤 K_doc 은 버린다 — 파일에 넣지 않는다.
//   ⑤ 만든 파일을 **발행 화면과 같은 검사**(parseLockFile)로 다시 읽어 본다. 통과하지 못하는 파일을 내주지 않는다.
//
// ⚠ 이 파일은 외부 잠금 페이지 저장소로 **글자 그대로 복사된다**(scripts/export-open.mjs). 이미지 압축(canvas)은 브라우저 전용이라
//   직접 부르지 않고 `deps.compress` 로 받는다 — 그래서 Node 시험이 이 함수를 그대로 돌린다.

import { encryptContent, genKdocHex } from "./contentCrypto";
import { roundAfterTime } from "./drand";
import { newPostId } from "./ids";
import { buildQrimgSrc, encodePostBodyV2, type DeltaOp } from "./postBody";
import { sealKdocOffline } from "./tlockOffline";
import {
  GCM_OVERHEAD_BYTES,
  LOCK_FORMAT,
  LOCK_LIMITS,
  bytesToBase64,
  openDateProblem,
  parseLockFile,
  sha256Hex,
  type LockBlob,
  type LockFileProblem,
  type LockFileV1,
} from "./lockFile";

/** 렌더 쪽 허용 목록과 같다(postBody.ts IMAGE_MIME_RE · imageCompress.ts IMAGE_MIME_ALLOWED). */
const IMAGE_MIME_RE = /^image\/(jpeg|png|webp|gif|avif)$/;
/** 이미지 평문 상한 — 암호화 뒤에도 100 KiB 안이다(imageCompress.ts IMAGE_TARGET_BYTES 와 같다). */
export const LOCK_IMAGE_PLAIN_MAX = LOCK_LIMITS.cipherMaxBytes - GCM_OVERHEAD_BYTES;

export type LockDraft = {
  title: string;
  preview: string;
  openDateMs: number;
  /** Quill 델타 — 이미지는 data: URL 로 들어온다(잠금 페이지의 편집기가 그렇게 넣는다). */
  ops: DeltaOp[];
};

export type LockDeps = {
  nowMs: number;
  /** 어느 빌드가 만들었는가(build.json 의 커밋). */
  commit: string;
  /** 허용 형식이 아니거나 너무 큰 이미지를 줄인다(브라우저: imageCompress.ts). 없으면 그런 이미지는 거부한다. */
  compress?: (bytes: Uint8Array, mime: string) => Promise<{ bytes: Uint8Array; mime: string }>;
};

export type LockResult =
  | { ok: true; file: LockFileV1; json: string }
  | { ok: false; problem: LockFileProblem | "empty_body" | "image_unreadable" };

export function dataUrlToBytes(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  try {
    if (m[2]) {
      const bin = atob(m[3]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { mime: m[1], bytes };
    }
    return { mime: m[1], bytes: new TextEncoder().encode(decodeURIComponent(m[3])) };
  } catch {
    return null;
  }
}

function hasContent(ops: DeltaOp[]): boolean {
  return ops.some((op) => (typeof op.insert === "string" ? op.insert.trim().length > 0 : typeof op.insert === "object" && op.insert !== null));
}

async function blobOf(cipher: Uint8Array): Promise<LockBlob> {
  return { cipher: bytesToBase64(cipher), sha256: await sha256Hex(cipher), bytes: cipher.length };
}

export async function sealLockFile(d: LockDraft, deps: LockDeps): Promise<LockResult> {
  const title = d.title.trim();
  const preview = d.preview.trim();
  if (title.length < 1 || title.length > LOCK_LIMITS.titleMax) return { ok: false, problem: "bad_title" };
  if (preview.length < 1 || preview.length > LOCK_LIMITS.previewMax) return { ok: false, problem: "bad_preview" };
  const dateProblem = openDateProblem(d.openDateMs, deps.nowMs);
  if (dateProblem) return { ok: false, problem: dateProblem };
  if (!hasContent(d.ops)) return { ok: false, problem: "empty_body" };

  const postId = newPostId();
  const kDocHex = genKdocHex();
  const round = roundAfterTime(d.openDateMs);

  // ── 이미지 — 같은 data URL 은 한 번만 싣는다 ──
  const bySrc = new Map<string, string>();
  const images: LockBlob[] = [];
  const ops: DeltaOp[] = [];
  for (const op of d.ops) {
    const src = typeof op.insert === "object" && op.insert !== null ? (op.insert as { image?: unknown }).image : undefined;
    if (src === undefined) {
      ops.push(op);
      continue;
    }
    if (typeof src !== "string" || !src.startsWith("data:")) return { ok: false, problem: "bad_image" };
    let ref = bySrc.get(src);
    if (!ref) {
      const decoded = dataUrlToBytes(src);
      if (!decoded) return { ok: false, problem: "image_unreadable" };
      let { bytes, mime } = decoded;
      if (!IMAGE_MIME_RE.test(mime) || bytes.length > LOCK_IMAGE_PLAIN_MAX) {
        if (!deps.compress) return { ok: false, problem: "image_too_large" };
        ({ bytes, mime } = await deps.compress(bytes, mime));
        if (!IMAGE_MIME_RE.test(mime) || bytes.length > LOCK_IMAGE_PLAIN_MAX) return { ok: false, problem: "image_too_large" };
      }
      if (images.length >= LOCK_LIMITS.imagesMax) return { ok: false, problem: "too_many_images" };
      const plainSha = await sha256Hex(bytes);
      const blob = await blobOf(await encryptContent(kDocHex, bytes));
      images.push(blob);
      ref = buildQrimgSrc({ tx: null, cipherSha256: blob.sha256, sha256: plainSha, mime });
      bySrc.set(src, ref);
    }
    ops.push({ ...op, insert: { ...(op.insert as object), image: ref } });
  }

  // ── 본문 ──
  const plain = new TextEncoder().encode(JSON.stringify(encodePostBodyV2(title, ops)));
  if (plain.length > LOCK_LIMITS.cipherMaxBytes - GCM_OVERHEAD_BYTES) return { ok: false, problem: "body_too_large" };
  const contentSha256 = await sha256Hex(plain);
  const body = await blobOf(await encryptContent(kDocHex, plain));

  // ── 잠금 — 이 줄 뒤로 K_doc 은 이 함수 밖으로 나가지 않는다 ──
  const sealedKdoc = await sealKdocOffline(round, postId, kDocHex);

  const file: LockFileV1 = {
    format: LOCK_FORMAT,
    postId,
    title,
    preview,
    openDateMs: d.openDateMs,
    round,
    contentSha256,
    body,
    images,
    sealedKdoc,
    sealer: { commit: deps.commit },
    madeAtMs: deps.nowMs,
  };
  const json = JSON.stringify(file);
  // 발행 화면과 같은 검사로 다시 읽는다 — 통과 못 하는 파일을 내주면 작성자는 업로드한 뒤에야 안다.
  const check = await parseLockFile(json, deps.nowMs);
  if (!check.ok) return { ok: false, problem: check.problem };
  return { ok: true, file, json };
}
