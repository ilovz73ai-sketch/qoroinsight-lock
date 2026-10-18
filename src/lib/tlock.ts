// 타임락 봉인 — 글의 복호화 키(K_doc)를 공개일의 drand 라운드로 잠근다.
//
// 이것이 이 서비스의 영구성 보장이다: 봉인본은 암호문과 함께 Arweave에 실리므로, 서버가 배신하든
// 사라지든 공개일이 오면 누구나 drand 서명 하나로 키를 열어 글을 읽을 수 있다. 그리고 봉인은
// 한 번 공개되면 **회수할 수 없다** — 공개일을 미루는 것은 운영자·작성자 포함 누구에게도 불가능하다
// (조기 공개는 그냥 키를 공표하면 된다. 비대칭은 의도다).
//
// qoropick의 tlock.ts와 달리 nonce를 넣지 않는다: 저쪽 페이로드(pick·spin)는 가짓수가 1만이라
// 동일 평문 탐지가 실제 위협이지만, K_doc은 256비트 난수라 페이로드 자체가 이미 유일하다.

import { Buffer, timelockEncrypt, timelockDecrypt } from "tlock-js";
import { drandClient } from "./drand";

export const SEAL_VERSION = 1 as const;

export type SealedKdocPayload = {
  v: typeof SEAL_VERSION;
  postId: string;
  /** 32바이트 hex(64자). AES-256-GCM 키. */
  kDocHex: string;
};

/** 잠금 안에 들어가는 평문 — 앱의 sealKdoc 과 외부 잠금 페이지의 sealKdocOffline(tlockOffline.ts)이 **같은 함수**를 쓴다.
 *  두 벌로 적으면 언젠가 한쪽 글만 공개일에 안 열린다. */
export function sealPayloadJson(postId: string, kDocHex: string): string {
  const payload: SealedKdocPayload = { v: SEAL_VERSION, postId, kDocHex };
  return JSON.stringify(payload);
}

/** 봉인은 발행 시 브라우저에서 일어난다. 서버는 라운드 재유도로 검증만 한다(posts.ts). */
export async function sealKdoc(round: number, postId: string, kDocHex: string): Promise<string> {
  return timelockEncrypt(round, Buffer.from(sealPayloadJson(postId, kDocHex), "utf8"), drandClient());
}

/**
 * 봉인이 **어느 라운드로** 잠겼는지를 열지 않고 읽는다. age armor의 헤더에 라운드가 평문으로
 * 적혀 있다(`-> tlock <round> <chainHash>`) — 검증기가 "매니페스트가 주장하는 라운드"와
 * "봉인에 실제 박힌 라운드"를 대조하는 데 쓴다. 이 대조가 없으면 공개일보다 늦은 라운드로
 * 봉인해 두고도 검사 ③(정수 대조)을 통과할 수 있다. 형식을 못 읽으면 null(검증기는 실패 처리).
 */
export function sealedRoundOf(armored: string): number | null {
  try {
    const body = armored
      .split("\n")
      .filter((l) => l.length > 0 && !l.startsWith("-----"))
      .join("");
    const decoded = atob(body);
    const match = decoded.slice(0, 512).match(/-> tlock (\d+) [0-9a-f]+/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export type UnsealKdocResult =
  | { ok: true; postId: string; kDocHex: string }
  /** 복호화 자체가 안 됐다(아직 라운드가 안 나왔거나, 애초에 우리 암호문이 아니다). */
  | { ok: false; reason: "DECRYPT_FAILED" }
  /** 열리긴 했는데 안이 우리 형식이 아니다. */
  | { ok: false; reason: "MALFORMED" };

/**
 * 봉인을 연다. 목표 라운드가 아직 발행되지 않았으면 실패한다 — 그게 타임락의 전부다.
 * 실패를 예외가 아니라 값으로 돌려준다: 커먼즈 일괄 공개에서 글 하나의 손상이 나머지를 멈추면 안 된다.
 */
export async function unsealKdoc(ciphertext: string): Promise<UnsealKdocResult> {
  let plain: Buffer;
  try {
    plain = await timelockDecrypt(ciphertext, drandClient());
  } catch {
    return { ok: false, reason: "DECRYPT_FAILED" };
  }
  try {
    const parsed = JSON.parse(plain.toString("utf8")) as Partial<SealedKdocPayload>;
    if (parsed.v !== SEAL_VERSION) return { ok: false, reason: "MALFORMED" };
    if (typeof parsed.postId !== "string" || typeof parsed.kDocHex !== "string") {
      return { ok: false, reason: "MALFORMED" };
    }
    if (!/^[0-9a-f]{64}$/.test(parsed.kDocHex)) return { ok: false, reason: "MALFORMED" };
    return { ok: true, postId: parsed.postId, kDocHex: parsed.kDocHex };
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
}
