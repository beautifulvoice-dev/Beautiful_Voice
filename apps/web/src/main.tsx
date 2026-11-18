import type { HealthResponse } from '@bv/contracts';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
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
    <main>
      <h1>BeautifulVoice</h1>
      <button type="button" onClick={checkApi}>API 연결 확인</button>
      <p role="status">{status}</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
