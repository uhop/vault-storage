import type {ServerResponse} from 'node:http';

export interface ApiError {
  error: string;
  code: string;
  details?: Record<string, unknown>;
}

export const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload).toString()
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
  const body: ApiError = details ? {error, code, details} : {error, code};
  sendJson(res, status, body);
};

export const sendNoContent = (res: ServerResponse): void => {
  res.writeHead(204);
  res.end();
};

export const sendText = (
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string
): void => {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body).toString()
  });
  res.end(body);
};
