// C-03 수용 기준: 모바일 화면에서 등록 → 검색 → 수정. 데이터는 합성(절대 규칙 8).
import { render, screen, waitFor, within } from '@testing-library/react';
import { CalendarApiProvider, createMemoryCalendarApi } from '@/features/calendar/api';
import { seedCalendar } from '@/features/calendar/mockData';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { describe, expect, it } from 'vitest';
import { SessionLoaderProvider } from '@/features/auth/session';
import { createMemoryCustomerApi, CustomerApiProvider, CustomerConflictError, type CustomerApi } from '@/features/customers/api';
import { HttpError, NetworkError } from '@/lib/http';
import { formatBirthdate, shopToday, visitHistory, type Visit } from '@/features/customers/model';
import { routes } from '@/routes';
import { setTestWidth } from './setup';

function renderAt(path: string, api: CustomerApi = createMemoryCustomerApi()) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <SessionLoaderProvider value={async () => ({ shopId: 'shop-1' })}>
      <CustomerApiProvider value={api}>
        <RouterProvider router={router} />
      </CustomerApiProvider>
    </SessionLoaderProvider>,
  );
  return router;
}

/** 목록 줄 글자 — 장식(이름 첫 글자 동그라미, aria-hidden)은 뺀다. */
const visibleText = (el: Element) =>
  [...el.childNodes].filter((n) => !(n instanceof Element && n.getAttribute('aria-hidden') === 'true')).map((n) => n.textContent).join('');
const names = () => within(screen.getByRole('list', { name: '고객 목록' })).getAllByRole('link').map(visibleText);

const search = async (text: string) => {
  await screen.findByRole('list', { name: '고객 목록' });
  await userEvent.type(screen.getByRole('searchbox', { name: '고객 검색' }), text);
};

describe('고객 목록·검색', () => {
  it('고객 수와, 같은 이름이면 "동명 n"을 보인다(W5 디자인)', async () => {
    renderAt('/customers');
    await screen.findByRole('list', { name: '고객 목록' });
    expect(screen.getByText('활성 고객 4명')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '고객' }).previousElementSibling).toHaveTextContent('내 매장'); // 폰 제목 위 매장 이름
    expect(screen.getAllByText('동명 2')).toHaveLength(2); // 김하늘 두 명
  });

  it('이름으로 찾는다 — 띄어쓰기는 무시, 검색어는 주소에 남기지 않는다', async () => {
    const router = renderAt('/customers');
    await search('이 서윤');
    expect(names()).toEqual(['이서윤010-0000-0003']);
    expect(router.state.location.search).toBe('');
  });

  it('전화번호 일부로 찾는다', async () => {
    renderAt('/customers');
    await search('0002');
    expect(names()).toEqual(['김하늘010-0000-0002']);
  });

  it('검색 결과 없음과 불러오기 실패를 다르게 보여 준다', async () => {
    renderAt('/customers');
    await search('없는사람');
    expect(await screen.findByText('검색 결과가 없어요')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('고객 카드에서 뒤로 오면 검색이 유지된다', async () => {
    const router = renderAt('/customers');
    await search('서윤');
    await userEvent.click(screen.getByRole('link', { name: /이서윤/ }));
    await screen.findByRole('heading', { level: 1, name: '이서윤' });
    await router.navigate(-1);
    expect(await screen.findByRole('searchbox', { name: '고객 검색' })).toHaveValue('서윤');
    // 목록은 비동기로 다시 불러오므로 걸러진 결과가 올 때까지 기다린다.
    await waitFor(() => expect(names()).toEqual(['이서윤010-0000-0003']));
  });

  it('불러오기에 실패하면 다시 시도할 수 있다', async () => {
    const real = createMemoryCustomerApi();
    let fail = true;
    const api: CustomerApi = { ...real, list: (q) => (fail ? Promise.reject(new Error('offline')) : real.list(q)) };
    renderAt('/customers', api);
    expect(await screen.findByRole('alert')).toHaveTextContent('불러오지 못했어요');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByRole('list', { name: '고객 목록' })).toBeInTheDocument();
  });
});

describe('고객 등록 시트 (W5 디자인 "+ 고객: 시트")', () => {
  it('"+ 고객"을 누르면 목록 위에 등록 시트가 열리고, 취소하면 목록으로 돌아가며 검색어는 남는다', async () => {
    const router = renderAt('/customers');
    await search('김');
    await userEvent.click(screen.getByRole('link', { name: '+ 고객' }));
    const sheet = await screen.findByRole('dialog', { name: '고객 등록' });
    expect(router.state.location.pathname).toBe('/customers/new');
    // 목록은 시트 뒤에 그대로 있다(시트가 열리면 화면 읽기에서는 뒤를 가린다).
    expect(document.querySelector('ul[aria-label="고객 목록"]')).toHaveTextContent('김하늘');
    expect(within(sheet).getByLabelText('이름 (필수)')).toHaveValue('');

    await userEvent.click(within(sheet).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/customers');
    expect(screen.getByRole('searchbox', { name: '고객 검색' })).toHaveValue('김');
  });

  it('시트에서 저장하면 그 고객 상세로 간다', async () => {
    const router = renderAt('/customers/new');
    const sheet = await screen.findByRole('dialog', { name: '고객 등록' });
    await userEvent.type(within(sheet).getByLabelText('이름 (필수)'), '최가람');
    await userEvent.click(within(sheet).getByRole('button', { name: '저장' }));
    expect(await screen.findByRole('heading', { level: 1, name: '최가람' })).toBeInTheDocument();
    expect(router.state.location.pathname).toMatch(/^\/customers\/c\d+$/u);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('고객 등록 → 검색 → 수정', () => {
  it('이름이 없으면 저장하지 않는다', async () => {
    renderAt('/customers/new');
    await userEvent.click(await screen.findByRole('button', { name: '저장' }));
    expect(screen.getByText('이름을 입력해 주세요.')).toBeInTheDocument();
  });

  it('등록하고, 목록에서 찾고, 전화번호를 고친다', async () => {
    const router = renderAt('/customers/new');
    await userEvent.type(await screen.findByLabelText('이름 (필수)'), '최가람');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByRole('heading', { level: 1, name: '최가람' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '정보' })).toHaveTextContent('전화없음');

    await router.navigate('/customers');
    await search('가람');
    await userEvent.click(await screen.findByRole('link', { name: /최가람/ }));
    await userEvent.click(await screen.findByRole('link', { name: '정보 고치기' }));
    const phone = await screen.findByLabelText('전화번호');
    await userEvent.type(phone, '010-0000-12');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(screen.getByText(/전화번호 형식이 맞지 않아요/)).toBeInTheDocument();

    await userEvent.type(phone, '34');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByRole('region', { name: '정보' })).toHaveTextContent('010-0000-1234');
  });

  it('같은 이름이 있으면 확인을 받고, 원장이 다른 고객이라 하면 따로 저장한다', async () => {
    const api = createMemoryCustomerApi();
    renderAt('/customers/new', api);
    await userEvent.type(await screen.findByLabelText('이름 (필수)'), '김하늘');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('같은 이름의 고객이 있어요');
    expect(within(alert).getAllByRole('listitem')).toHaveLength(2);

    await userEvent.click(screen.getByRole('button', { name: '다른 고객이에요, 저장' }));
    expect(await screen.findByRole('heading', { level: 1, name: '김하늘' })).toBeInTheDocument();
    expect(await api.list('김하늘')).toHaveLength(3);
  });
});

describe('생년월일·거주지 (BEA-172, 명세 1 §2.3)', () => {
  it('등록할 때 넣으면 상세에 보이고, 목록 카드에는 보이지 않는다', async () => {
    const router = renderAt('/customers/new');
    await userEvent.type(await screen.findByLabelText('이름 (필수)'), '최가람');
    await userEvent.type(screen.getByLabelText('생년월일'), '1990-02-28');
    await userEvent.type(screen.getByLabelText('거주지'), '합성시 가상구');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    const info = await screen.findByRole('region', { name: '정보' });
    expect(info).toHaveTextContent('생년월일1990년 2월 28일');
    expect(info).toHaveTextContent('거주지합성시 가상구');

    await router.navigate('/customers');
    await search('가람');
    expect(names()).toEqual(['최가람전화번호 없음']);
  });

  it('수정에서 지우면 "없음"으로 돌아간다', async () => {
    renderAt('/customers/c3/edit');
    const birthdate = await screen.findByLabelText('생년월일');
    expect(birthdate).toHaveValue('1992-07-15');
    await userEvent.clear(birthdate);
    await userEvent.clear(screen.getByLabelText('거주지'));
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    const info = await screen.findByRole('region', { name: '정보' });
    expect(info).toHaveTextContent('생년월일없음');
    expect(info).toHaveTextContent('거주지없음');
  });

  it('생년월일을 덜 입력하면(브라우저가 빈 값을 줌) 지우지 않고 저장을 막는다 (#52 리뷰)', async () => {
    const api = createMemoryCustomerApi();
    renderAt('/customers/c3/edit', api);
    const birthdate = await screen.findByLabelText('생년월일');
    // 노트북 브라우저에서 "1990. 02."까지만 치면 value는 ''이고 validity.badInput이 true다. jsdom에는 없어서 흉내 낸다.
    await userEvent.clear(birthdate);
    Object.defineProperty(birthdate, 'validity', { value: { badInput: true } });
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(screen.getByText(/생년월일을 끝까지 입력하거나/)).toBeInTheDocument();
    expect((await api.get('c3'))?.birthdate).toBe('1992-07-15');
  });

  it('생년월일 달력은 오늘(매장 날짜)까지만 고를 수 있다', async () => {
    renderAt('/customers/new');
    expect(await screen.findByLabelText('생년월일')).toHaveAttribute('max', shopToday());
  });

  it('날짜 표시와 매장 날짜 계산', () => {
    expect(formatBirthdate('2000-01-05')).toBe('2000년 1월 5일');
    // 서울 자정 직후(UTC로는 전날 15시)는 서울 날짜로 센다.
    expect(shopToday(new Date('2026-11-20T15:30:00Z'))).toBe('2026-11-21');
  });
});

describe('동명이인 확인과 입력이 어긋나지 않는다 (#32 리뷰)', () => {
  it('확인 중에는 입력을 잠그고, 확인 뒤 이름·전화를 바꾸면 확인을 버린다', async () => {
    const real = createMemoryCustomerApi();
    let release = () => {};
    const api: CustomerApi = {
      ...real,
      checkSameName: (s) => new Promise((done) => (release = () => done(real.checkSameName(s)))),
    };
    renderAt('/customers/new', api);
    const name = await screen.findByLabelText('이름 (필수)');
    await userEvent.type(name, '김하늘');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(name).toBeDisabled();
    expect(screen.getByLabelText('전화번호')).toBeDisabled();

    release();
    expect(await screen.findByRole('alert')).toHaveTextContent('같은 이름의 고객이 있어요');
    await userEvent.type(screen.getByLabelText('전화번호'), '010');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('등록 시트 주소 (#79 리뷰)', () => {
  it('/customers/new/ 처럼 끝에 슬래시가 있어도 등록 시트가 열린다', async () => {
    renderAt('/customers/new/');
    expect(await screen.findByRole('dialog', { name: '고객 등록' })).toBeInTheDocument();
  });
});

describe('고객 상세: 정보·예약·방문 이력 (명세 3 2A-2.4)', () => {
  it('다가오는 예약과 지난 방문을 나눠, 원장이 표시한 상태 그대로 보인다. 지갑·문자는 자리만 있다(W6 디자인, 웹 두 칸)', async () => {
    setTestWidth(1280);
    renderAt('/customers/c1');
    const upcoming = within(await screen.findByRole('list', { name: '다가오는 예약' })).getAllByRole('listitem');
    expect(upcoming.map((v) => v.lastChild?.textContent)).toEqual(['예정']);
    const past = within(screen.getByRole('list', { name: '지난 방문' })).getAllByRole('listitem');
    expect(past.map((v) => v.lastChild?.textContent)).toEqual(['완료', '취소', '노쇼', '완료']);
    expect(screen.getByRole('region', { name: '지갑' })).toHaveTextContent('준비 중');
    expect(screen.getByRole('region', { name: '문자' })).toHaveTextContent('준비 중');
    // 날짜는 캘린더와 같은 "11/24(화) 16:00" 형식
    expect(upcoming[0]!.textContent).toMatch(/^\d{1,2}\/\d{1,2}\([월화수목금토일]\) \d{2}:\d{2}/);
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('폰에서는 정보·예약·지갑·문자 탭으로 나뉘고 예약 탭부터 보인다(W6 디자인)', async () => {
    setTestWidth(390);
    renderAt('/customers/c1');
    const tabs = await screen.findByRole('tablist');
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['정보', '예약', '지갑', '문자']);
    expect(within(tabs).getByRole('tab', { name: '예약' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('list', { name: '다가오는 예약' })).toBeInTheDocument();
    await userEvent.click(within(tabs).getByRole('tab', { name: '정보' }));
    expect(await screen.findByRole('region', { name: '정보' })).toHaveTextContent('특이사항민감성 피부');
  });

  it('없는 고객은 안내를 보여 준다', async () => {
    renderAt('/customers/nope');
    expect(await screen.findByText('없는 고객이에요')).toBeInTheDocument();
  });

  it('지난 예약도 저절로 완료되지 않고, 되돌린 예약(무효)은 이력에 없다', () => {
    const v = (id: string, startsAt: string, status: Visit['status']): Visit => ({ id, startsAt, menu: '', status });
    const history = visitHistory([
      v('past', '2026-11-18T02:00:00Z', 'scheduled'),
      v('undone', '2026-11-19T02:00:00Z', 'voided'),
      v('next', '2026-11-20T02:00:00Z', 'scheduled'),
    ]);
    expect(history.map((h) => [h.id, h.status])).toEqual([
      ['next', 'scheduled'],
      ['past', 'scheduled'],
    ]);
  });
});

describe('비활성 고객 (BEA-173, 결정 R30·S4)', () => {
  const seed = () => ({
    customers: [
      { id: 'a', name: '합성가', phone: '01000000011', memo: null },
      { id: 'b', name: '합성나', phone: null, memo: null, active: false },
    ],
    visits: {},
  });

  it('W5: 기본은 활성 고객만, 비활성 칩을 누르면 비활성 고객만', async () => {
    renderAt('/customers', createMemoryCustomerApi(seed()));
    await waitFor(() => expect(names()).toHaveLength(1));
    expect(names()[0]).toContain('합성가');
    expect(screen.getByText('활성 고객 1명')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: '비활성' }));
    await waitFor(() => expect(names()[0]).toContain('합성나'));
    expect(names()).toHaveLength(1);
  });

  it('W6: ⋯ → 비활성으로 바꾸기는 확인을 묻고, 바꾸면 배지 + 예약 넣기 꺼짐, 다시 활성으로 되돌린다', async () => {
    setTestWidth(1280);
    renderAt('/customers/a', createMemoryCustomerApi(seed()));
    await screen.findByRole('heading', { level: 1, name: '합성가' });
    expect(screen.getByRole('button', { name: '예약 넣기' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: '더보기' }));
    await userEvent.click(await screen.findByRole('button', { name: '비활성으로 바꾸기' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('비활성으로 바꿔도 예약과 지갑 기록은 그대로 남아요. 예약도 취소되지 않아요.');
    await userEvent.click(within(confirm).getByRole('button', { name: '비활성으로 바꾸기' }));
    expect(await screen.findByText('비활성')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '예약 넣기' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '더보기' }));
    await userEvent.click(await screen.findByRole('button', { name: '다시 활성으로' }));
    await waitFor(() => expect(screen.queryByText('비활성')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '예약 넣기' })).toBeEnabled();
  });
});

describe('비활성 바꾸기 — 응답 유실·충돌 (#81 리뷰)', () => {
  const seed = () => ({ customers: [{ id: 'a', name: '합성가', phone: null, memo: null, version: 1 }], visits: {} });
  const deactivate = async () => {
    await userEvent.click(screen.getByRole('button', { name: '더보기' }));
    await userEvent.click(await screen.findByRole('button', { name: '비활성으로 바꾸기' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '비활성으로 바꾸기' }));
  };

  it.each([
    ['연결 끊김', new NetworkError()],
    ['502', new HttpError(502, 'BAD_GATEWAY')],
    ['504', new HttpError(504, 'GATEWAY_TIMEOUT')],
  ])('%s 후 다시 누르면 같은 Idempotency-Key로 보낸다', async (_label, error) => {
    setTestWidth(1280);
    const real = createMemoryCustomerApi(seed());
    const keys: (string | undefined)[] = [];
    let lose = true;
    const api: CustomerApi = {
      ...real,
      setActive: async (id, active, o) => {
        keys.push(o?.idempotencyKey);
        if (lose) {
          lose = false;
          throw error;
        }
        return real.setActive(id, active, o);
      },
    };
    renderAt('/customers/a', api);
    await screen.findByRole('heading', { level: 1, name: '합성가' });
    await deactivate();
    expect(await screen.findByRole('alert')).toHaveTextContent('바꾸지 못했어요');
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '비활성으로 바꾸기' }));
    expect(await screen.findByText('비활성')).toBeInTheDocument();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it('다시 활성으로 바꾸는 동안 더보기 메뉴를 열 수 없다', async () => {
    setTestWidth(1280);
    const real = createMemoryCustomerApi(seed());
    await real.setActive('a', false);
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    const api: CustomerApi = {
      ...real,
      setActive: async (id, active, options) => {
        attempts += 1;
        await pending;
        return real.setActive(id, active, options);
      },
    };

    renderAt('/customers/a', api);
    await screen.findByText('비활성');
    const menu = screen.getByRole('button', { name: '더보기' });
    await userEvent.click(menu);
    await userEvent.click(await screen.findByRole('button', { name: '다시 활성으로' }));
    expect(menu).toBeDisabled();
    await userEvent.click(menu);
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(attempts).toBe(1);

    release();
    await waitFor(() => expect(screen.getByRole('button', { name: '예약 넣기' })).toBeEnabled());
    expect(screen.getByRole('button', { name: '더보기' })).toBeEnabled();
  });

  it('version 충돌이면 최신 고객을 다시 읽어 보여 주고 알린다(다른 기기에서 이미 비활성으로 바꾼 경우)', async () => {
    setTestWidth(1280);
    const real = createMemoryCustomerApi(seed());
    const api: CustomerApi = {
      ...real,
      setActive: async (id) => {
        await real.setActive(id, false); // 다른 기기에서 먼저 바꿈
        throw new CustomerConflictError();
      },
    };
    renderAt('/customers/a', api);
    await screen.findByRole('heading', { level: 1, name: '합성가' });
    await deactivate();
    expect(await screen.findByRole('alert')).toHaveTextContent('다른 곳에서 이 고객이 바뀌어 최신 상태를 다시 불러왔어요');
    expect(await screen.findByText('비활성')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});

describe('W6 예약 넣기', () => {
  it('고객 상세의 예약 넣기는 캘린더의 예약 넣기를 그 고객으로 채워 연다', async () => {
    setTestWidth(1280);
    const router = createMemoryRouter(routes, { initialEntries: ['/customers/c3'] });
    render(
      <SessionLoaderProvider value={async () => ({ shopId: 'shop-1' })}>
        <CalendarApiProvider value={createMemoryCalendarApi(seedCalendar('2026-11-18'))}>
          <CustomerApiProvider value={createMemoryCustomerApi()}>
            <RouterProvider router={router} />
          </CustomerApiProvider>
        </CalendarApiProvider>
      </SessionLoaderProvider>,
    );
    await screen.findByRole('heading', { level: 1, name: '이서윤' });
    await userEvent.click(screen.getByRole('button', { name: '예약 넣기' }));
    const sheet = await screen.findByRole('dialog', { name: '예약 넣기' });
    expect(router.state.location.pathname).toBe('/calendar');
    expect(within(sheet).getByPlaceholderText('이름 두 글자')).toHaveValue('이서윤');
    expect(router.state.location.state).toBeNull(); // 다시 열리지 않게 지움
  });
});
