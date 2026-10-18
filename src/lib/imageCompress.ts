// 이미지 압축 — 브라우저 전용(canvas).
//
// 왜 여기서 줄이는가: 이미지 한 장의 **암호문**이 100KiB(Arweave Turbo 무료 구간)를 넘으면
// 업로드가 거부된다. 원본을 그대로 올리게 두면 "발행 버튼에서야 실패"가 되므로, 에디터에
// 넣는 순간 한도 안으로 줄인다. AES-GCM 오버헤드(28바이트)를 빼고 95KiB를 목표로 잡는다.

import { tr } from "@/lib/i18n";

const MAX_DIMENSION = 1280;
const QUALITY_STEPS = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35];

/** 이미지 한 장의 평문 상한. 암호화(AES-GCM +28바이트) 후에도 100KiB 업로드 한도 안이다. */
export const IMAGE_TARGET_BYTES = 95 * 1024;

/** 렌더 측 parseQrimgSrc의 mime 화이트리스트와 같아야 한다 — 어긋나면 발행은 되는데
 *  영원히 못 여는 이미지가 불변 본문에 봉인된다(적대 리뷰 발견). */
export const IMAGE_MIME_ALLOWED = /^image\/(jpeg|png|webp|gif|avif)$/;

/** 인코딩 후보(선호 순). 같은 품질에서 AVIF는 JPEG의 절반 안팎이라 95KiB 예산에서 화질이
 *  가장 좋다. canvas.toBlob은 미지원 형식이면 **PNG로 조용히 폴백**하므로 1×1 프로브로 실제
 *  지원을 확인해 고른다 — Safari는 AVIF/WebP 인코딩이 없어 JPEG로 떨어진다(디코드는 모든
 *  최신 브라우저가 AVIF를 지원하므로 독자 쪽은 문제없다). */
const CODEC_CANDIDATES = ["image/avif", "image/webp", "image/jpeg"] as const;
export type ImageMime = (typeof CODEC_CANDIDATES)[number];

export type CompressedImage = { bytes: Uint8Array; mime: ImageMime; dataUrl: string };

let codecPromise: Promise<ImageMime> | null = null;
function pickCodec(): Promise<ImageMime> {
  codecPromise ??= (async () => {
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    for (const mime of CODEC_CANDIDATES) {
      if (mime === "image/jpeg") break; // 마지막 보루 — 프로브가 필요 없다.
      try {
        const blob = await toBlob(probe, 0.8, mime);
        if (blob.type === mime) return mime;
      } catch {
        // 다음 후보로.
      }
    }
    return "image/jpeg";
  })();
  return codecPromise;
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(tr("이미지를 읽을 수 없습니다.", "Couldn't read the image.")));
    };
    img.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement, quality: number, mime: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error(tr("이미지 변환에 실패했습니다.", "Couldn't convert the image.")))),
      mime,
      quality,
    );
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error(tr("이미지 인코딩에 실패했습니다.", "Couldn't encode the image.")));
    r.readAsDataURL(blob);
  });
}

/** 파일 → 한도 안 JPEG. 툴바·붙여넣기·드래그 등 모든 유입 경로가 이 함수를 지나야 한다. */
export async function compressImageFile(file: File): Promise<CompressedImage> {
  return compressImageBlob(file);
}

/** Blob → 한도 안 AVIF/WebP/JPEG(브라우저 지원 순). 품질을 낮춰도 안 들어가면 변을 반씩
 *  줄여 다시 시도한다. AVIF 인코딩은 JPEG보다 느리지만 1280px 상한에서는 체감 이내다. */
export async function compressImageBlob(blob: Blob): Promise<CompressedImage> {
  if (!blob.type.startsWith("image/")) throw new Error(tr("이미지 파일이 아닙니다.", "This isn't an image file."));
  const codec = await pickCodec();
  const img = await loadImage(blob);

  let width = img.naturalWidth;
  let height = img.naturalHeight;
  if (width === 0 || height === 0) throw new Error(tr("이미지 크기를 읽을 수 없습니다.", "Couldn't read the image size."));
  const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));

  for (let attempt = 0; attempt < 4; attempt++) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(tr("캔버스를 만들 수 없습니다.", "Couldn't create a canvas."));
    // 흰 바탕: JPEG 폴백에는 알파가 없고, 코덱마다 투명 처리가 갈리면 같은 글이 브라우저에
    // 따라 다르게 보인다 — 전 코덱 동일한 결과를 위해 항상 깐다.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    for (const q of QUALITY_STEPS) {
      const out = await toBlob(canvas, q, codec);
      if (out.size <= IMAGE_TARGET_BYTES) {
        return {
          bytes: new Uint8Array(await out.arrayBuffer()),
          mime: codec,
          dataUrl: await blobToDataUrl(out),
        };
      }
    }
    width = Math.max(1, Math.round(width / 2));
    height = Math.max(1, Math.round(height / 2));
  }
  throw new Error(
    tr("이미지를 100KiB 안으로 줄이지 못했습니다. 더 작은 이미지를 사용해 주세요.", "Couldn't shrink the image to 100 KiB or less. Please use a smaller image."),
  );
}
