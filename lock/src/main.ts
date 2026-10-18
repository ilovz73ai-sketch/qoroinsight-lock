// qoro insight 잠금 페이지 — 글을 쓰고, 이 브라우저 안에서 공개일까지 잠그고, 잠금 파일을 내려받는다.
//
// 이 페이지가 하는 일은 셋뿐이다: 편집(Quill) · 잠금(src/lib/lockSeal.ts — insight 와 같은 파일) · 내려받기(파일 둘).
// 평문은 이 탭의 메모리와 이 기기의 localStorage(쓰던 글 임시 저장) 밖으로 나가지 않는다 — 배포본은 CSP connect-src 'none' 이라
// 네트워크 요청 자체가 불가능하다(vite.config.mts 머리말). insight 로 가는 것은 사람이 들고 가는 잠금 파일이고, 거기에는 키가 없다.

import Quill from "quill";
import "quill/dist/quill.snow.css";
import { sealLockFile } from "@/lib/lockSeal";
import { LOCK_LIMITS, GCM_OVERHEAD_BYTES, lockProblemText, type LockFileProblem } from "@/lib/lockFile";
import { estimateBodyBytes, QRIMG_CIPHER_SRC_LEN, type DeltaOp } from "@/lib/postBody";
import { compressImageBlob, compressImageFile } from "@/lib/imageCompress";
import { tr } from "@/lib/i18n";
import { COMMIT, INSIGHT_WRITE_URL, SOURCE_URL } from "./config";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const DAY = 86_400_000;
const DRAFT_KEY = "qoroinsight-lock-draft";
const LANG_KEY = "qoroinsight-lock-lang";

// ── 언어 ─────────────────────────────────────────────────────────────────────
function setLang(lang: "ko" | "en") {
  document.documentElement.dataset.lang = lang;
  document.documentElement.lang = lang;
  $("lang").textContent = lang === "en" ? "KO" : "EN";
  ($("title") as HTMLInputElement).placeholder = tr("무엇을 경험했나요?", "What did you experience?");
  ($("preview") as HTMLTextAreaElement).placeholder = tr("결제 없이 누구나 보는 소개", "An introduction anyone can see");
  updateMeter();
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* 저장이 막혀도 이 탭에서는 바뀐다 */
  }
}

// ── 공개일 ───────────────────────────────────────────────────────────────────
function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** 날짜 입력값 → 그날 자정(이 기기의 시간대). 최소값을 오늘 + 6일로 두어 서버의 "최소 5일"을 자정 절단이 깨지 않게 한다. */
function openDateMsOf(value: string): number {
  return new Date(`${value}T00:00:00`).getTime();
}
const openInput = $("open") as HTMLInputElement;
const today = new Date();
openInput.min = localDate(new Date(today.getTime() + 6 * DAY));
openInput.max = localDate(new Date(today.getTime() + 1095 * DAY));

// ── 편집기 ───────────────────────────────────────────────────────────────────
// 서식은 insight 의 읽기 화면이 그리는 것만(QuillEditor 의 QUILL_FORMATS 에서 유튜브를 뺐다 — 이 페이지는 프레임을 띄우지 않는다).
const FORMATS = ["header", "bold", "italic", "underline", "strike", "blockquote", "code-block", "list", "link", "image"];
const quill: Quill = new Quill("#editor", {
  theme: "snow",
  formats: FORMATS,
  placeholder: "",
  modules: {
    uploader: { handler: (_range: unknown, files: File[]) => void insertImages(files) },
    toolbar: {
      container: [[{ header: [2, 3, false] }], ["bold", "italic", "underline", "strike"], [{ list: "ordered" }, { list: "bullet" }], ["blockquote"], ["link", "image"]],
      handlers: {
        link: () => {
          const range = quill.getSelection(true);
          const url = prompt(tr("링크 주소 (https://…)", "Link address (https://…)"), "https://");
          if (!url) return;
          if (!/^https?:\/\//i.test(url)) return setStatus(tr("http(s) 주소만 넣을 수 있습니다.", "Only http(s) addresses are allowed."), true);
          if (range.length > 0) quill.formatText(range.index, range.length, "link", url, "user");
          else quill.insertText(range.index, url, { link: url }, "user");
        },
        image: () => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = "image/*";
          input.onchange = () => input.files?.[0] && void insertImages([input.files[0]]);
          input.click();
        },
      },
    },
  },
});

/** 넣는 순간 줄인다 — 잠글 때 100 KiB 를 넘어 실패하면 쓴 사람이 그때서야 안다(insight 의 편집기와 같은 규율). */
async function insertImages(files: File[]) {
  for (const file of files) {
    try {
      const { dataUrl } = await compressImageFile(file);
      const range = quill.getSelection(true);
      quill.insertEmbed(range.index, "image", dataUrl, "user");
      quill.setSelection(range.index + 1, 0);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : tr("이미지를 넣지 못했습니다.", "Couldn't insert the image."), true);
    }
  }
}

function ops(): DeltaOp[] {
  return quill.getContents().ops as DeltaOp[];
}

function imageCount(o: DeltaOp[]): number {
  const seen = new Set<string>();
  for (const op of o) {
    const src = typeof op.insert === "object" && op.insert !== null ? (op.insert as { image?: unknown }).image : undefined;
    if (typeof src === "string") seen.add(src);
  }
  return seen.size;
}

function updateMeter() {
  const o = ops();
  const bytes = estimateBodyBytes(($("title") as HTMLInputElement).value.trim(), o, QRIMG_CIPHER_SRC_LEN);
  const max = LOCK_LIMITS.cipherMaxBytes - GCM_OVERHEAD_BYTES;
  const imgs = imageCount(o);
  const kib = (n: number) => (n / 1024).toFixed(1);
  $("meter").textContent = tr(
    `본문 ${kib(bytes)} / ${kib(max)} KiB · 이미지 ${imgs} / ${LOCK_LIMITS.imagesMax}장`,
    `Body ${kib(bytes)} / ${kib(max)} KiB · ${imgs} / ${LOCK_LIMITS.imagesMax} images`,
  );
  $("meter").classList.toggle("bad", bytes > max || imgs > LOCK_LIMITS.imagesMax);
  refreshButton();
}

// ── 쓰던 글 임시 저장(이 기기에만) ──────────────────────────────────────────────
type Draft = { title: string; preview: string; open: string; ops: DeltaOp[] };
function saveDraft() {
  const d: Draft = { title: ($("title") as HTMLInputElement).value, preview: ($("preview") as HTMLTextAreaElement).value, open: openInput.value, ops: ops() };
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    // 그림이 많으면 저장 공간이 모자랄 수 있다 — 쓰기는 계속된다. 잠그면 원본 파일이 나온다.
  }
}
function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    const d = JSON.parse(raw) as Partial<Draft>;
    ($("title") as HTMLInputElement).value = d.title ?? "";
    ($("preview") as HTMLTextAreaElement).value = d.preview ?? "";
    if (d.open) openInput.value = d.open;
    if (Array.isArray(d.ops)) quill.setContents(d.ops as never, "silent");
  } catch {
    /* 깨진 임시 저장은 무시한다 */
  }
}

// ── 상태·버튼 ────────────────────────────────────────────────────────────────
function setStatus(text: string, bad = false) {
  $("status").textContent = text;
  $("status").classList.toggle("bad", bad);
}
function refreshButton() {
  const ready =
    ($("title") as HTMLInputElement).value.trim().length > 0 &&
    ($("preview") as HTMLTextAreaElement).value.trim().length > 0 &&
    openInput.value !== "" &&
    quill.getText().trim().length + imageCount(ops()) > 0 &&
    ($("ack") as HTMLInputElement).checked;
  ($("seal") as HTMLButtonElement).disabled = !ready;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 클릭이 내려받기를 시작한 뒤에 푼다 — 같은 틱에 풀면 일부 브라우저가 빈 파일을 받는다.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const EXTRA_PROBLEMS: Record<string, { ko: string; en: string }> = {
  empty_body: { ko: "본문을 써 주세요.", en: "Please write the body." },
  image_unreadable: { ko: "읽을 수 없는 이미지가 있습니다.", en: "An image couldn't be read." },
};

async function seal() {
  const button = $("seal") as HTMLButtonElement;
  button.disabled = true;
  setStatus(tr("잠그는 중… (이미지가 많으면 몇 초 걸립니다)", "Locking… (this can take a few seconds with many images)"));
  const title = ($("title") as HTMLInputElement).value;
  const preview = ($("preview") as HTMLTextAreaElement).value;
  const openDateMs = openDateMsOf(openInput.value);
  const body = ops();
  try {
    const r = await sealLockFile(
      { title, preview, openDateMs, ops: body },
      {
        nowMs: Date.now(),
        commit: COMMIT,
        compress: async (bytes, mime) => {
          const c = await compressImageBlob(new Blob([bytes as BlobPart], { type: mime }));
          return { bytes: c.bytes, mime: c.mime };
        },
      },
    );
    if (!r.ok) {
      const t = EXTRA_PROBLEMS[r.problem] ?? lockProblemText(r.problem as LockFileProblem);
      setStatus(tr(t.ko, t.en), true);
      refreshButton();
      return;
    }
    // 원본 — 평문이 남는 유일한 곳이다. insight 의 "원본 내려받기"와 같은 형식이라 나중에 insight 초안으로도 읽힌다.
    const original = { format: "qoro-insight-original/v1", postId: r.file.postId, title: r.file.title, preview: r.file.preview, openDate: openInput.value, ops: body, exportedAtMs: Date.now() };
    const lockName = `qoro-insight-${r.file.postId}.qlock`;
    const originalName = `qoro-insight-${r.file.postId}-original.json`;
    const originalJson = JSON.stringify(original, null, 1);
    download(lockName, r.json);
    download(originalName, originalJson);
    showDone(r.file.postId, lockName, r.json, originalName, originalJson);
    setStatus("");
  } catch (err) {
    setStatus(err instanceof Error ? err.message : tr("잠그지 못했습니다.", "Couldn't lock it."), true);
    refreshButton();
  }
}

function showDone(postId: string, lockName: string, lockJson: string, originalName: string, originalJson: string) {
  const done = $("done");
  done.hidden = false;
  done.innerHTML = "";
  const h = document.createElement("p");
  h.className = "lead ok";
  h.innerHTML = `<b><span class="ko">잠갔습니다.</span><span class="en">Locked.</span></b> <span class="mono"></span>`;
  (h.querySelector(".mono") as HTMLElement).textContent = postId;
  const p = document.createElement("p");
  p.className = "lead";
  p.innerHTML =
    '<span class="ko">파일 둘을 내려받았습니다: <b>잠금 파일(.qlock)</b>은 qoro insight 의 경험 남기기 → “외부 잠금 페이지에서 잠근 글 올리기”에서 고르세요. <b>원본(-original.json)</b>은 평문이 남는 유일한 사본입니다 — 꼭 보관해 주세요. 저희는 이 글을 공개일 전에 열 수 없으므로 원본을 되살려 드릴 방법도 없습니다.</span>' +
    '<span class="en">Two files were downloaded: choose the <b>lock file (.qlock)</b> in qoro insight under Share an experience → “Publish a post locked on the external lock page”. The <b>original (-original.json)</b> is the only copy of the plaintext — be sure to keep it. We can\'t open this post before its open date, so we have no way to restore the original for you.</span>';
  const row = document.createElement("div");
  row.className = "row";
  const again1 = document.createElement("button");
  again1.className = "btn outline";
  again1.innerHTML = '<span class="ko">잠금 파일 다시 받기</span><span class="en">Download the lock file again</span>';
  again1.onclick = () => download(lockName, lockJson);
  const again2 = document.createElement("button");
  again2.className = "btn outline";
  again2.innerHTML = '<span class="ko">원본 다시 받기</span><span class="en">Download the original again</span>';
  again2.onclick = () => download(originalName, originalJson);
  const go = document.createElement("a");
  go.href = INSIGHT_WRITE_URL;
  go.rel = "noopener noreferrer";
  go.className = "btn";
  go.innerHTML = '<span class="ko">qoro insight 로 가기</span><span class="en">Go to qoro insight</span>';
  row.append(again1, again2, go);
  done.append(h, p, row);
  done.scrollIntoView({ behavior: "smooth" });
}

// ── 시작 ─────────────────────────────────────────────────────────────────────
($("source") as HTMLAnchorElement).href = SOURCE_URL;
$("source").textContent = SOURCE_URL.replace("https://", "");
$("commit").textContent = COMMIT.slice(0, 12);
let initialLang: "ko" | "en" = "ko";
try {
  initialLang = localStorage.getItem(LANG_KEY) === "en" ? "en" : navigator.language.startsWith("ko") ? "ko" : "en";
} catch {
  initialLang = navigator.language.startsWith("ko") ? "ko" : "en";
}
loadDraft();
if (!openInput.value) openInput.value = localDate(new Date(today.getTime() + 182 * DAY));
setLang(initialLang);

$("lang").onclick = () => setLang(document.documentElement.dataset.lang === "en" ? "ko" : "en");
quill.on("text-change", () => {
  updateMeter();
  saveDraft();
});
for (const id of ["title", "preview", "open"]) {
  $(id).addEventListener("input", () => {
    updateMeter();
    saveDraft();
  });
}
$("ack").addEventListener("change", refreshButton);
$("seal").onclick = () => void seal();
$("reset").onclick = () => {
  if (!confirm(tr("쓰던 글을 지우고 새로 쓸까요? (내려받은 파일은 그대로입니다)", "Clear what you were writing and start over? (Files you downloaded stay as they are.)"))) return;
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* 무시 */
  }
  ($("title") as HTMLInputElement).value = "";
  ($("preview") as HTMLTextAreaElement).value = "";
  quill.setContents([] as never, "silent");
  $("done").hidden = true;
  ($("ack") as HTMLInputElement).checked = false;
  updateMeter();
};
