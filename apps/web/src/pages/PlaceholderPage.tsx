// 각 담당 작업(C-08 캘린더·C-14 매출)이 들어오기 전까지 자리를 지키는 화면.
import { EmptyState } from '@/components/states/DataState';

export function PlaceholderPage({ title }: { title: string }) {
  return (
    <>
      <h1 className="px-4 pt-6 text-xl font-semibold">{title}</h1>
      <EmptyState title="준비 중인 화면이에요" />
    </>
  );
}
