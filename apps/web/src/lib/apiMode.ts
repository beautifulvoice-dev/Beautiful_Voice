// 실제·가짜 API 전환(설계 05 D2). 운영은 실제 API만. 테스트는 Provider로 가짜를 주입한다.
// 로컬에서 서버 없이 화면만 볼 때는 apps/web/.env.local 에 VITE_FAKE_API=1 (또는 로그인 건너뛰기 VITE_DEV_SKIP_LOGIN=1)을 명시한다.
// import.meta.env.DEV 조건이라 배포 빌드에는 가짜가 들어가지 않는다 — 서버 오류가 가짜 성공으로 바뀌지 않게.
import { DEV_SKIP_LOGIN } from '@/features/auth/session';

export const FAKE_API = import.meta.env.DEV && (import.meta.env.VITE_FAKE_API === '1' || DEV_SKIP_LOGIN);
