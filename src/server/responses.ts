import type {ServerResponse} from 'node:http';

/**
 * The error envelope: `error`, `code`, and `details` are the fields every
 * client here reads; `type`, `title`, `status`, and `detail` are the RFC 9457
 * Problem Details members, added 2026-09-07 so the shape is a superset of the
 * standard and can migrate to it without churn. The media type stays
 * `application/json` — switching it is the breaking half.
 */
export interface ApiError {
  error: string;
  code: string;
  details?: Record<string, unknown>;
  type: string;
  title: string;
  status: number;
  detail: string;
}

/** A stable short name for a code: `replace_assert_failed` → "Replace assert failed". */
const titleOf = (code: string): string => {
  const words = code.replace(/[_-]+/g, ' ').trim();
  return words.length === 0 ? 'Error' : words[0]!.toUpperCase() + words.slice(1);
};

export const sendJson = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload).toString(),
    ...headers
  });
  res.end(payload);
};

export const sendError = (
  res: ServerResponse,
  status: number,
  code: string,
  error: string,
  details?: Record<string, unknown>
): void => {
  const problem = {
    type: `urn:vault-storage:problem:${code}`,
    title: titleOf(code),
    status,
    detail: error
  };
  const body: ApiError = details ? {error, code, details, ...problem} : {error, code, ...problem};
  sendJson(res, status, body);
};

export const sendNoContent = (res: ServerResponse, headers?: Record<string, string>): void => {
  res.writeHead(204, headers);
  res.end();
};

export const sendText = (
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  headers?: Record<string, string>
): void => {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body).toString(),
    ...headers
  });
  res.end(body);
};
