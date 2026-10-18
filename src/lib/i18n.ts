// 이 저장소만의 파일이다(insight 에서 복사되지 않는다). insight 의 i18n.tsx 는 React 를 쓰는데 이 페이지에는 React 가 없다 —
// 공용 파일(imageCompress.ts 등)이 부르는 `tr` 하나만 같은 뜻으로 둔다: 부르는 순간의 언어로 고른 문자열.
export function tr(ko: string, en: string): string {
  return typeof document !== "undefined" && document.documentElement.dataset.lang === "en" ? en : ko;
}
