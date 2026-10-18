import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

// qoro insight 잠금 페이지 — 운영 서버와 분리된 정적 사이트(GitHub Pages). 작성자가 글을 쓰고 **자기 브라우저 안에서** 공개일까지
// 잠그는 곳이다. 결과는 파일(.qlock) 하나이고 그 안에는 암호문과 drand 잠금뿐이다 — 복호화 키는 공개일의 drand 서명 안에만 있다.
//
// 빌드된 페이지에는 CSP `connect-src 'none'` 이 박힌다: 이 페이지는 **어떤 네트워크 요청도 할 수 없다.** 글을 어디로도 보낼 수
// 없다는 것을, 코드를 읽지 않고도 브라우저가 보장한다. (개발 서버는 HMR 웹소켓이 필요해 CSP 를 넣지 않는다.)
//
// 단, CSP 는 페이지 **이동**은 막지 못한다 — 고친 잠금 페이지는 링크에 글을 실어 보낼 수 있다. 그래서 배포 빌드는 **재현 가능**해야
// 한다: 같은 커밋이면 누가 어디서 빌드해도 바이트까지 같은 파일이 나와야, 누구나 "지금 서비스 중인 페이지 = 공개 코드"를 확인할
// 수 있다(scripts/check-lock.ts). 그러려면
//  · 배포 빌드는 환경 변수·.env 파일을 읽지 않는다. 코드에서 import.meta.env 를 쓰지 마라.
//  · 커밋은 전체 해시를 쓴다(--short 는 저장소마다 길이가 다르다).
//  · 빌드 시각 같은 값은 넣지 않는다.
// (qoro pick 의 Sealer 와 같은 방법이다 — https://github.com/ilovz73ai-sketch/qoropick)

const root = fileURLToPath(new URL(".", import.meta.url));

const commit = (() => {
  try {
    return execSync("git rev-parse HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "dev";
  }
})();

// img-src blob: — 이미지 압축(imageCompress.ts)이 blob URL 로 그림을 읽는다. data: — 편집기 안의 그림이 data URL 이다.
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; " +
  "connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function csp(): Plugin {
  return {
    name: "qoroinsight-lock-csp",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        return html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
      },
    },
  };
}

/** build.json — 배포본이 어느 커밋에서 나왔는지. check-lock 이 이걸 보고 그 커밋을 다시 빌드해 대조한다. */
function buildInfo(info: { commit: string }): Plugin {
  return {
    name: "qoroinsight-lock-build-info",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "build.json", source: JSON.stringify(info, null, 2) + "\n" });
    },
  };
}

export default defineConfig({
  root,
  base: "./",
  resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
  define: { __LOCK_COMMIT__: JSON.stringify(commit) },
  server: { port: 5175 },
  build: { outDir: "dist", emptyOutDir: true },
  plugins: [csp(), buildInfo({ commit })],
});
