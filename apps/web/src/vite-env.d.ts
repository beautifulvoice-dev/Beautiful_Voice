/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 개발 서버에서만: '1'이면 로그인 확인을 건너뛴다(features/auth/session.ts). */
  readonly VITE_DEV_SKIP_LOGIN?: string;
}
