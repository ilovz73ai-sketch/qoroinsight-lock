// drand quicknet — 타임락의 시계. (qoropick src/lib/drand.ts를 그대로 이식했다.)
//
// 왜 quicknet인가: League of Entropy 메인넷에서 **타임락 암호화를 지원하는 유일한 체인**이다
// (G1 서명 + bls-unchained-g1-rfc9380). 다른 체인은 서명이 G2라 tlock의 페어링이 성립하지 않는다.
// 상수를 손으로 적지 않고 tlock-js가 들고 있는 defaultChainInfo를 그대로 쓴다 — 라이브러리가
// 실제로 봉인에 쓰는 값과 우리가 라운드를 계산하는 값이 어긋날 여지를 없앤다.

import { defaultChainInfo, defaultChainUrl, mainnetClient } from "tlock-js";

export const QUICKNET = {
  chainHash: defaultChainInfo.hash,
  genesisTimeMs: defaultChainInfo.genesis_time * 1000,
  periodMs: defaultChainInfo.period * 1000,
  url: defaultChainUrl,
} as const;

/** tlock 암·복호화에 쓰는 클라이언트. mainnetClient()가 곧 quicknet이다. */
export const drandClient = mainnetClient;

/** 라운드 r이 발행되는 시각(ms). r=1이 genesis다. */
export function roundEmissionMs(round: number): number {
  return QUICKNET.genesisTimeMs + (round - 1) * QUICKNET.periodMs;
}

/**
 * 시각 t **이후**(같은 순간 포함) 처음 발행되는 라운드.
 *
 * ⚠ drand-client의 roundAt()을 쓰면 안 된다. 그쪽은 floor(...)+1 이라 "t 시점에 **이미 나온**
 *   마지막 라운드"를 준다. 그 값으로 봉인하면 공개일 전에 누구나 열 수 있다 — 이 서비스에서는
 *   유료 글 전부가 즉시 무료가 된다는 뜻이다(암호는 멀쩡히 동작하고 약속만 무너진다 —
 *   최악의 실패 방식이다).
 *
 * 불변식: roundEmissionMs(r) >= t 이고 roundEmissionMs(r-1) < t.
 */
export function roundAfterTime(timeMs: number): number {
  if (!Number.isFinite(timeMs)) throw new Error("roundAfterTime: 유한한 시각이어야 한다");
  if (timeMs < QUICKNET.genesisTimeMs) throw new Error("roundAfterTime: genesis 이전은 라운드가 없다");
  return Math.ceil((timeMs - QUICKNET.genesisTimeMs) / QUICKNET.periodMs) + 1;
}

export type Beacon = {
  round: number;
  /** 라운드 서명(hex). 이것이 복호화 키의 재료이자 검증 대상이다. */
  signature: string;
  randomness: string;
};

// 운영 주체가 다른 두 릴레이. 검증 화면이 둘을 받아 서로 대조한다 — 한 릴레이가 거짓 서명을
// 주더라도 다른 쪽과 다르면 즉시 드러난다.
export const RELAYS = ["https://api.drand.sh", "https://drand.cloudflare.com"] as const;

export async function fetchBeacon(round: number, relay: string, signal?: AbortSignal): Promise<Beacon> {
  const res = await fetch(`${relay}/${QUICKNET.chainHash}/public/${round}`, {
    signal,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`beacon ${round} @ ${relay}: HTTP ${res.status}`);
  const json = (await res.json()) as Partial<Beacon>;
  if (typeof json.signature !== "string" || typeof json.round !== "number") {
    throw new Error(`beacon ${round} @ ${relay}: 응답 형식이 다르다`);
  }
  if (json.round !== round) throw new Error(`beacon ${round} @ ${relay}: 다른 라운드가 왔다(${json.round})`);
  return { round: json.round, signature: json.signature, randomness: json.randomness ?? "" };
}

/**
 * 라운드가 릴레이에 실릴 때까지 기다렸다 받아 온다.
 *
 * 라운드는 목표 시각에 **생성**되지만 릴레이에 실려 퍼지는 데 1~2초가 더 든다. 공개일 직후의
 * 첫 조회는 404가 정상이다. 그걸 실패로 처리하면 글이 영영 공개되지 않는다.
 */
export async function fetchBeaconWithRetry(
  round: number,
  opts: { timeoutMs?: number; relays?: readonly string[] } = {},
): Promise<Beacon> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const relays = opts.relays ?? RELAYS;
  const giveUpAt = Date.now() + timeoutMs;
  let delay = 500;
  let last: unknown;

  for (;;) {
    for (const relay of relays) {
      try {
        return await fetchBeacon(round, relay);
      } catch (err) {
        last = err;
      }
    }
    if (Date.now() >= giveUpAt) break;
    await new Promise((r) => setTimeout(r, Math.min(delay, Math.max(0, giveUpAt - Date.now()))));
    delay = Math.min(delay * 2, 4000);
  }
  throw new Error(`drand 라운드 ${round}을 ${timeoutMs}ms 안에 받지 못했다: ${String(last)}`);
}
