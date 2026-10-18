// "지금 서비스 중인 잠금 페이지가 이 저장소의 코드 그대로인가?" — 누구나 돌릴 수 있는 확인.
//   npm run check-lock [-- <잠금 페이지 주소>]     (기본: GitHub Pages 의 운영 페이지)
//
// 왜: 잠금 페이지는 네트워크 요청을 못 하게 막혀 있지만(CSP connect-src 'none'), 페이지 **이동**은 막을 수 없다. 고친 페이지는
// qoro insight 로 가는 링크에 글을 몰래 실어 보낼 수 있다. 그래서 "코드를 읽어 봤다"가 아니라 "배포된 파일이 이 코드에서 나온
// 것과 바이트까지 같다"를 확인한다. GitHub Pages 는 모두에게 같은 파일을 준다 — 한 사람의 확인이 모두의 답이다.
//
// 순서: 배포본의 build.json 으로 커밋을 알아내고 → 그 커밋을 그대로 다시 빌드해서 → 파일마다 sha256 을 배포본과 대조한다.
// 빌드가 재현되는 이유는 lock/vite.config.mts 머리말에 있다. (qoro pick 의 check-sealer 와 같은 방법이다.)

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const LIVE = "https://ilovz73ai-sketch.github.io/qoroinsight-lock/";
const live = (process.argv.slice(2).find((a) => !a.startsWith("--")) ?? LIVE).replace(/\/?$/, "/");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  });
}

async function main() {
  console.log(`Live lock page: ${live}`);
  const infoRes = await fetch(new URL("build.json", live), { cache: "no-store" });
  const info = infoRes.ok ? ((await infoRes.json()) as { commit?: string }) : null;
  if (!info?.commit || !/^[0-9a-f]{40}$/.test(info.commit)) {
    console.error("✗ The live page has no build.json, so it wasn't built by this repository's workflow.");
    process.exit(1);
  }
  const head = git("rev-parse", "HEAD");
  if (head !== info.commit) {
    console.log(`The live page was built from commit ${info.commit}, and you have ${head} checked out. Run:\n  git checkout ${info.commit} && npm ci && npm run check-lock`);
    process.exit(2);
  }
  if (git("status", "--porcelain", "--", "lock", "src", "package.json", "package-lock.json")) {
    console.error("✗ Your checkout has local changes in the files that make the page, so check from a clean checkout.");
    process.exit(1);
  }

  const out = mkdtempSync(path.join(tmpdir(), "qoroinsight-lock-"));
  try {
    execFileSync("npx", ["vite", "build", "--config", "lock/vite.config.mts", "--outDir", out, "--emptyOutDir", "--logLevel", "warn"], {
      stdio: "inherit",
    });
    const files = walk(out).sort();
    let bad = 0;
    for (const f of files) {
      const mine = sha(readFileSync(path.join(out, f)));
      const res = await fetch(new URL(f, live), { cache: "no-store" });
      const theirs = res.ok ? sha(new Uint8Array(await res.arrayBuffer())) : null;
      const ok = theirs === mine;
      if (!ok) bad++;
      console.log(`${ok ? "✓" : "✗"} ${f}${ok ? "" : theirs ? " — the live file is different" : ` — missing on the live site (HTTP ${res.status})`}`);
    }
    if (bad) {
      console.log(`\n✗ ${bad} of ${files.length} files differ, so the live page is NOT exactly this code.`);
      process.exit(1);
    }
    console.log(`\n✓ All ${files.length} files match, so the live page is exactly commit ${head.slice(0, 7)} of this code.`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
