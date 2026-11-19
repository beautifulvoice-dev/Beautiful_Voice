import type { CommonErrorCode, ErrorResponse } from '@bv/contracts';
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ApiError } from './api-error';

// express 타입 의존성을 늘리지 않으려고 필요한 메서드만 적는다.
interface HttpResponse {
  status(code: number): { json(body: unknown): void };
}

const CODE_BY_STATUS: Record<number, CommonErrorCode> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
};

// 모든 오류 응답을 { code, message, details }로 통일한다(F-05, 02-architecture §4).
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const { status, body } = this.toErrorResponse(exception);
    response.status(status).json(body);
  }

  private toErrorResponse(exception: unknown): { status: number; body: ErrorResponse<string> } {
    if (exception instanceof ApiError) {
      return { status: exception.status, body: exception.toResponse() };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = CODE_BY_STATUS[status] ?? (status < 500 ? 'BAD_REQUEST' : 'INTERNAL_ERROR');
      return { status, body: { code, message: messageOf(exception), details: {} } };
    }
    // 예상 못 한 오류: 내부 메시지에 개인정보가 섞일 수 있어 응답·로그 모두 이름만 남긴다.
    const name = exception instanceof Error ? exception.name : typeof exception;
    this.logger.error(`Unhandled ${name}`);
    return {
      status: 500,
      body: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', details: {} },
    };
  }
}

function messageOf(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  const message = (response as { message?: unknown }).message;
  if (typeof message === 'string') return message;
  return exception.message;
}
