// 네트워크 없이 잠근다 — 외부 잠금 페이지(AGENTS.md 43)가 `connect-src 'none'` 로도 동작하는 이유.
//
// tlock-js 의 timelockEncrypt 는 체인 정보(공개키)를 클라이언트에게 묻는다. 보통 클라이언트는 그것을 HTTP 로 받지만, 잠그는 데
// 필요한 것은 그 정보 하나뿐이고 라이브러리가 quicknet 의 값(defaultChainInfo)을 들고 있다. 그래서 그 값을 주는 오프라인
// 클라이언트를 넘긴다 — 나머지 메서드는 불리면 안 되므로 던진다. (qoro pick 의 seal-crypto.ts 와 같은 방법이다.)
//
// ⚠ 잠금 내용은 tlock.ts 의 sealKdoc 과 **같은 형식**이어야 한다({ v: SEAL_VERSION, postId, kDocHex }). 공개기(opener.ts)와
//   커먼즈 레시피가 같은 unsealKdoc 으로 연다 — 형식이 갈리면 판매 안 함 글이 공개일에 안 열린다(그리고 공개기는 그 글을
//   "열 수 없음"으로 표시해 마감에 파기한다, AGENTS.md 42). 그래서 페이로드를 여기서 다시 짓지 않고 tlock.ts 의 것을 쓴다.
// ⚠ 이 파일은 외부 잠금 페이지 저장소로 **글자 그대로 복사된다**(scripts/export-open.mjs). 브라우저 전용 API·React·서버 모듈을
//   import 하지 마라 — 그 저장소에는 없다.

import { Buffer, defaultChainInfo, timelockEncrypt } from "tlock-js";
import { QUICKNET } from "./drand";
import { sealPayloadJson } from "./tlock";

type ChainClient = Parameters<typeof timelockEncrypt>[2];

const offlineQuicknet = {
  options: {
    disableBeaconVerification: false,
    noCache: false,
    chainVerificationParams: { chainHash: QUICKNET.chainHash, publicKey: defaultChainInfo.public_key },
  },
  chain: () => ({ baseUrl: "offline:quicknet", info: async () => defaultChainInfo }),
  latest: async () => {
    throw new Error("offline client: no network");
  },
  get: async () => {
    throw new Error("offline client: no network");
  },
} as unknown as ChainClient;

/** K_doc 을 drand 라운드에 잠근다 — 네트워크를 한 번도 부르지 않는다. 결과는 sealKdoc 과 같은 모양의 age armor. */
export async function sealKdocOffline(round: number, postId: string, kDocHex: string): Promise<string> {
  if (!Number.isSafeInteger(round) || round < 1) throw new Error("sealKdocOffline: 라운드가 올바르지 않다");
  return timelockEncrypt(round, Buffer.from(sealPayloadJson(postId, kDocHex), "utf8"), offlineQuicknet);
}
