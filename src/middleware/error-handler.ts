import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

import { HttpError } from '../utils/http-error.js';

export const errorHandler: ErrorRequestHandler = (error: unknown, request, response, _next) => {
  if (
    error instanceof SyntaxError &&
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    error.type === 'entity.parse.failed'
  ) {
    response.status(400).json({
      error: { code: 'INVALID_JSON', message: 'The request body must contain valid JSON.' },
    });
    return;
  }
  if (error instanceof ZodError) {
    response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'The request is invalid.',
        details: error.flatten(),
      },
    });
    return;
  }
  if (error instanceof HttpError) {
    response.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    });
    return;
  }
  const pgCode =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (pgCode === '23505') {
    response
      .status(409)
      .json({ error: { code: 'CONFLICT', message: 'That record already exists.' } });
    return;
  }
  request.log.error({ err: error }, 'Unhandled request error');
  const message =
    process.env.NODE_ENV !== 'production' && error instanceof Error
      ? error.message
      : 'An unexpected error occurred.';
  response
    .status(500)
    .json({ error: { code: 'INTERNAL_ERROR', message } });
};
