# qoro insight 잠금 페이지 · lock page

[qoro insight](https://insight.qoro.ooo)에서 **판매하지 않는 글**을 쓰는 곳입니다. 글은 **여러분의 브라우저 안에서** 공개일까지
잠기고, 나오는 것은 잠금 파일(.qlock) 하나입니다. 그 파일을 qoro insight 의 경험 남기기 → "외부 잠금 페이지에서 잠근 글
올리기"에서 고르면 발행됩니다.

## 무엇을 보장하나

- **이 페이지는 네트워크를 전혀 쓰지 않습니다.** 빌드된 페이지에 Content-Security-Policy `connect-src 'none'` 이 박혀 있어,
  코드를 읽지 않아도 브라우저가 "이 페이지는 어떤 요청도 보낼 수 없다"를 보장합니다. 글은 이 탭의 메모리와 이 기기의
  localStorage(쓰던 글 임시 저장) 밖으로 나가지 않습니다.
- **잠금 파일에는 복호화 키가 없습니다.** 본문·이미지는 AES-256-GCM 으로 암호화되고, 그 키는
  [drand](https://drand.love) quicknet 의 **공개일 라운드**에 타임락으로 잠깁니다. 그 라운드의 서명이 나오기 전에는 누구도 —
  작성자도, qoro insight 도 — 키를 계산할 수 없습니다. 공개일이 오면 qoro insight 가 그 서명으로 키를 풀어 글을 열고, 72시간
  뒤 Arweave 에 영구 보관합니다.
- **원본은 잠글 때 한 번 내려받는 파일뿐입니다.** 저희는 공개일 전에 이 글을 열 수 없으므로 원본을 되살려 드릴 수 없습니다.

## 서비스 중인 페이지가 이 코드인지 확인하기

CSP 는 페이지 **이동**까지 막지는 못합니다 — 고친 페이지는 링크에 글을 실어 보낼 수 있습니다. 그래서 배포 빌드는 재현
가능합니다: 같은 커밋이면 누가 빌드해도 바이트까지 같은 파일이 나옵니다.

```bash
npm ci
npm test
npm run check-lock        # 서비스 중인 페이지의 커밋을 다시 빌드해 파일마다 sha256 을 대조합니다
```

GitHub Pages 는 모두에게 같은 파일을 주므로, 한 사람의 확인이 모두의 답이 됩니다.

## 이 저장소의 파일

| 경로 | 무엇 |
|---|---|
| `lock/` | 잠금 페이지(편집기 · 잠그기 · 내려받기). |
| `src/lib/` | **qoro insight 가 실제로 쓰는 파일의 사본**입니다 — 잠금 파일 형식·검사(`lockFile.ts`), 잠그기(`lockSeal.ts`), 오프라인 타임락(`tlockOffline.ts`), 본문 형식(`postBody.ts`), 암호화(`contentCrypto.ts`). insight 발행 화면이 같은 `lockFile.ts` 로 파일을 검사합니다. `i18n.ts` 만 이 저장소의 것입니다(React 없는 `tr`). |
| `scripts/check-lock.ts` | 위의 재현 빌드 대조. |

## 여전히 믿어야 하는 것

drand 네트워크(임계값 이상의 노드가 공개일 전에 서명을 내지 않는다는 것), 여러분의 브라우저, 그리고 qoro insight 서버가 받은
암호문을 공개일까지 보관하고 공개일에 여는 것. 마지막은 공개 원장과 검증기로 밖에서 확인할 수 있습니다 — 판매하지 않는 글
(원장의 가격 "0")에 결제 기록이나 조기 공개가 있으면 검증기가 적색으로 표시합니다.

---

# qoro insight lock page

This is where you write a **post that isn't for sale** on [qoro insight](https://insight.qoro.ooo). The post is locked until its open
date **inside your own browser**, and the only output is one lock file (.qlock). Choose that file in qoro insight under Share an
experience → "Publish a post locked on the external lock page".

## What it guarantees

- **This page uses no network at all.** The built page carries the Content-Security-Policy `connect-src 'none'`, so the browser itself
  guarantees — without you reading the code — that it can't send any request. Your writing never leaves this tab's memory and this
  device's localStorage (a draft of what you're writing).
- **The lock file has no decryption key.** The body and images are encrypted with AES-256-GCM, and the key is time-locked to the
  **open date's round** of [drand](https://drand.love) quicknet. Until that round's signature is published, no one — not you, not
  qoro insight — can compute the key. When the open date comes, qoro insight unlocks the key with that signature, opens the post, and
  archives it permanently on Arweave 72 hours later.
- **The only original is the file you download when locking.** We can't open the post before its open date, so we can't restore it.

## Check that the live page is this code

CSP can't stop the page from **navigating** — a modified page could put your writing in a link. So the deploy build is reproducible:
the same commit gives byte-identical files no matter who builds it.

```bash
npm ci
npm test
npm run check-lock        # rebuilds the live page's commit and compares every file's sha256
```

GitHub Pages serves the same files to everyone, so one person's check covers everybody.

## What you still have to trust

The drand network (that a threshold of its nodes won't sign before the open date), your browser, and that qoro insight's server keeps
the ciphertext until the open date and opens it then. The last part can be checked from outside with the public ledger and verifier:
the verifier flags any payment record or early opening for a post that isn't for sale (price "0" on the ledger).

## License

MIT — see [LICENSE](LICENSE).
