/** Stable protocol failures; messages never include source text or environment values. */
export class ProtocolError extends Error {
  constructor(code, message, data = undefined) { super(message); this.code = code; this.data = data; }
}
export const invalid = message => new ProtocolError(-32602, message);
export const stale = message => new ProtocolError(-32801, message);
