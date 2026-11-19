// 로그인 화면 (U-2, 분해표 C-10): 카카오 먼저. 이메일 대안은 F-04 후속.
// 버튼은 서버의 카카오 시작 주소로 이동만 한다. 로그인이 끝나면 서버가 첫 화면(/)으로 돌려보낸다.
import { KAKAO_START_URL } from '@/features/auth/session';

export function LoginPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 px-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold">BeautifulVoice</h1>
        <p className="text-sm text-muted-foreground">원장님 카카오 계정으로 로그인해 주세요.</p>
      </div>
      <a
        href={KAKAO_START_URL}
        className="flex w-full max-w-xs items-center justify-center rounded-md bg-[#FEE500] px-4 py-3 font-medium text-black/85"
      >
        카카오로 로그인
      </a>
    </main>
  );
}
