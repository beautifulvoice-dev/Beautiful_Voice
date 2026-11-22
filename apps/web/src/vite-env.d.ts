/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 개발 서버에서만: '1'이면 로그인 확인을 건너뛴다(features/auth/session.ts). */
  readonly VITE_DEV_SKIP_LOGIN?: string;
  /** 개발 서버에서만: '1'이면 서버 대신 브라우저 메모리의 가짜 API를 쓴다(lib/apiMode.ts). */
  readonly VITE_FAKE_API?: string;
}
