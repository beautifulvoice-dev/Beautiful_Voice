import type { CommonErrorCode, ErrorResponse } from '@bv/contracts';

// 도메인·공통 규약 오류. 전역 필터(ApiExceptionFilter)가 { code, message, details }로 바꿔 응답한다.
// message·details에 개인정보(이름·전화번호·전사문)를 넣지 않는다(CLAUDE.md 절대 규칙 8).
export class ApiError<Code extends string = CommonErrorCode> extends Error {
  constructor(
    readonly status: number,
    readonly code: Code,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toResponse(): ErrorResponse<Code> {
    return { code: this.code, message: this.message, details: this.details };
  }
}
