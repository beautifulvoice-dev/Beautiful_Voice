import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CompletionHomePreview } from '@/pages/home/CompletionHomePreview';

describe('S6 홈 목 화면', () => {
  it('문자를 미리 본 뒤 승인하면 확인한 카드만 목록에서 빠진다', async () => {
    const user = userEvent.setup();
    render(<CompletionHomePreview />);
    const queue = screen.getByRole('region', { name: '내가 허가할 일' });
    const approve = screen.getByRole('button', { name: '허가하고 문자 보내기' });
    expect(approve).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '문자 미리 보기' }));
    expect(screen.getByText(/김서연님, 오늘/)).toBeInTheDocument();
    await user.click(approve);
    expect(screen.getByRole('status')).toHaveTextContent('김서연님 예약을 완료');
    expect(within(queue).queryByRole('button', { name: /김서연/ })).not.toBeInTheDocument();
    expect(within(queue).getByRole('button', { name: /박지민/ })).toBeInTheDocument();
    expect(approve).toBeDisabled();
  });

  it('선불 차감액이 바뀌면 재확인까지 승인하지 않는다', async () => {
    const user = userEvent.setup();
    render(<CompletionHomePreview />);
    await user.click(screen.getByRole('button', { name: /박지민/ }));
    await user.click(screen.getByRole('button', { name: '문자 미리 보기' }));
    const approve = screen.getByRole('button', { name: '허가하고 문자 보내기' });
    await user.click(approve);
    expect(screen.getByRole('alert')).toHaveTextContent('차감액이 바뀌었어요');
    expect(approve).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '문자 미리 보기' }));
    expect(screen.getByText(/박지민님.*40,000원/)).toBeInTheDocument();
    await user.click(approve);
    expect(screen.getByRole('status')).toHaveTextContent('박지민님 예약을 완료');
  });
});
