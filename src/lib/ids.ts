// 글 id.
//
// 12자 base32(i·l·o·u 제외 — 소리 내 불러 주거나 받아 적을 때 헷갈리는 글자가 없다).
// 글 링크는 공개 URL이므로 id의 일은 추측·무차별 대입을 막는 것이 아니라 충돌을 막는 것뿐이지만,
// qoropick과 같은 규약을 쓰면 가문 전체에서 id를 다루는 코드·정규식·DB 제약이 그대로 이식된다.

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const POST_ID_LENGTH = 12;

/** 모듈로 편향을 피하려고 256을 32로 나눠떨어지게 쓴다(byte & 31). */
export function newPostId(): string {
  const bytes = new Uint8Array(POST_ID_LENGTH);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => ALPHABET[b & 31]).join("");
}

export const POST_ID_RE = /^[0-9a-hjkmnp-tv-z]{12}$/;

export function isPostId(value: unknown): value is string {
  return typeof value === "string" && POST_ID_RE.test(value);
}
