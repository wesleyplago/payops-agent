export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'TOOL_NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_DENIED'
  | 'APPROVAL_EXPIRED'
  | 'REFUND_EXCEEDS_CAPTURE'
  | 'REFUND_DUPLICATE'
  | 'POLICY_VIOLATION'
  | 'GATEWAY_ERROR'
  | 'LEDGER_INVARIANT_VIOLATION'
  | 'SIMULATED_CRASH'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    httpStatus = 400,
    details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export class SimulatedCrash extends Error {
  constructor(message = 'simulated process death') {
    super(message);
    this.name = 'SimulatedCrash';
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export function isPgUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  );
}

export function toPublicError(err: unknown): {
  code: string;
  message: string;
  details?: unknown;
} {
  if (isAppError(err)) {
    return { code: err.code, message: err.message, details: err.details };
  }
  return { code: 'INTERNAL_ERROR', message: 'internal error' };
}
