/// <reference types="vite/client" />
// 빌드 때 박히는 값(vite.config.mts). import.meta.env 는 쓰지 않는다 — 배포 빌드가 빌드한 기계의 .env 에 따라 달라지면
// "서비스 중인 잠금 페이지 = 공개 코드" 확인(scripts/check-lock.ts)이 깨진다.
declare const __LOCK_COMMIT__: string;
