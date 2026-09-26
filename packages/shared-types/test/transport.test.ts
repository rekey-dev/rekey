import { describe, expect, it } from 'vitest';
import { neverConnected } from '../src/transport.js';

function socketError(code: string): Error {
  return Object.assign(new Error(`connect ${code}`), { code });
}

function fetchFailed(cause: unknown): TypeError {
  return Object.assign(new TypeError('fetch failed'), { cause });
}

describe('neverConnected', () => {
  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'])(
    'a %s under fetch failed never reached the server',
    (code) => {
      expect(neverConnected(fetchFailed(socketError(code)))).toBe(true);
    },
  );

  it('a refused localhost on both address families never reached the server', () => {
    const both = new AggregateError([socketError('ECONNREFUSED'), socketError('ECONNREFUSED')], '');
    expect(neverConnected(fetchFailed(both))).toBe(true);
  });

  it('an AggregateError where one family connected and then dropped may have reached it', () => {
    const mixed = new AggregateError([socketError('ECONNREFUSED'), socketError('ECONNRESET')], '');
    expect(neverConnected(fetchFailed(mixed))).toBe(false);
  });

  it.each(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT'])(
    'a %s came after the connection was made',
    (code) => {
      expect(neverConnected(fetchFailed(socketError(code)))).toBe(false);
    },
  );

  it('a request deadline is not proof: the server may have answered slowly', () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(neverConnected(timeout)).toBe(false);
  });

  it('nothing, or a cause chain that never names a code, is not proof', () => {
    expect(neverConnected(undefined)).toBe(false);
    expect(neverConnected(new Error('fetch failed'))).toBe(false);
    expect(neverConnected(fetchFailed(new AggregateError([], '')))).toBe(false);
  });
});
