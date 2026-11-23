// 로그인 화면 W0 (U-2, 분해표 C-10, 화면 설계서 §5 W0, 디자인 w0.png 왼쪽): 가운데 이름과 한 줄 소개, 아래 카카오 로그인.
// 이름은 Beautiful Voice(예외 E1 — 태그라인 없음). 카카오 버튼은 카카오 디자인 가이드대로(노랑, 말풍선, "카카오 로그인", 12px 모서리).
// 버튼은 서버의 카카오 시작 주소로 이동만 한다. 로그인이 끝나면 서버가 첫 화면(/)으로 돌려보낸다. 이메일 대안은 F-04 후속.

import { BRAND_NAME } from '@/brand';
import { KAKAO_START_URL } from '@/features/auth/session';

/** 카카오 말풍선 심볼(가이드의 검정 말풍선). */
function KakaoSymbol() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-[18px]" fill="currentColor">
      <path d="M12 3C6.48 3 2 6.58 2 11c0 2.86 1.88 5.37 4.7 6.78l-.95 3.48a.4.4 0 0 0 .61.44l4.13-2.75c.5.05 1 .08 1.51.08 5.52 0 10-3.58 10-8.03S17.52 3 12 3Z" />
    </svg>
  );
}

export function LoginPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pb-10">
      <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
        <h1 className="text-[40px] leading-none font-extrabold tracking-[-0.03em] text-brand-text">{BRAND_NAME}</h1>
        <p className="text-base text-ink-soft">
          말로 넣고, 화면에서 확인하는
          <br />
          우리 매장 장부
        </p>
      </div>
      <a
        href={KAKAO_START_URL}
        className="flex h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-kakao text-base font-semibold text-on-kakao"
      >
        <KakaoSymbol />
        카카오 로그인
      </a>
    </main>
  );
}
