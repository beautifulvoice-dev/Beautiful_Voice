// 설정 화면 자리. 매장 설정(C-01)이 들어오기 전까지 F-02의 API 연결 확인을 둔다.
import type { HealthResponse } from '@bv/contracts';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

export function SettingsPage() {
  const [status, setStatus] = useState('확인 전');

  async function checkApi() {
    setStatus('확인 중');
    try {
      const response = await fetch('/api/health');
      if (!response.ok) throw new Error('API request failed');
      const result = (await response.json()) as HealthResponse;
      setStatus(result.status === 'ok' ? '연결 정상' : '연결 실패');
    } catch {
      setStatus('연결 실패');
    }
  }

  return (
    <div className="flex flex-col gap-4 px-4 pt-6">
      <h1 className="text-xl font-semibold">설정</h1>
      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" onClick={checkApi}>
          API 연결 확인
        </Button>
        <p role="status" className="text-sm text-muted-foreground">
          {status}
        </p>
      </div>
    </div>
  );
}
