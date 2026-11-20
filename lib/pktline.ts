// Git's pkt-line framing: a 4-hexadecimal length prefix, then the payload. 0000 is a flush packet,
// 0001 a delimiter and 0002 a response-end packet. Everything the smart HTTP protocol carries — ref
// advertisements, ls-refs answers, fetch requests and their sections, receive-pack command lists and
// their report-status — travels in these frames, so one module owns them.

/** The largest payload a pkt-line may carry (65520 total, 4 of them the length prefix). */
export const PKT_LINE_MAX = 65520;

/** The payload size a pkt-line may carry. */
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

export type PacketKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Packet {
  kind: PacketKind;
  /** Empty for every control packet. */
  payload: Buffer;
  /** The bytes this packet occupies in the stream (4 for a control packet). */
  raw: Buffer;
}

/** One data packet around `payload` (a string is sent as UTF-8). */
export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) throw new Error(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte limit`);
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

/** The flush packet: the end of a section or of a request. */
export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delimiter packet: separates a v2 command from its arguments. */
export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Encode a mixed list of payloads and control packets. */
export function encodePktLines(lines: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktLineFlush());
    else if (line === 'delim') parts.push(pktLineDelim());
    else parts.push(encodePktLine(line));
  }
  return Buffer.concat(parts);
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Whether the next four bytes of a buffer spell a pkt-line header. */
export function hasPktHeader(buffer: Buffer, offset: number): boolean {
  if (offset + 4 > buffer.length) return false;
  return HEX4.test(buffer.subarray(offset, offset + 4).toString('ascii'));
}

/**
 * Decode a whole pkt-line stream. A buffer that starts with something other than a length prefix is
 * a protocol error; callers that must stay alive (a malformed request) catch it.
 */
export function decodePktLines(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (!hasPktHeader(buffer, offset)) throw new Error(`not a pkt-line at offset ${offset}`);
    const length = Number.parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0), raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0), raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0), raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error(`pkt-line length ${length} overruns the ${buffer.length}-byte body at offset ${offset}`);
    packets.push({
      kind: 'data',
      payload: buffer.subarray(offset + 4, offset + length),
      raw: buffer.subarray(offset, offset + length),
    });
    offset += length;
  }
  return packets;
}

/** The data packets of a stream as text, in order. */
export function packetsToLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

/**
 * Split a receive-pack request: the pkt-line command list up to its flush packet, then the bytes that
 * follow it (the packfile, absent for a delete-only push).
 */
export function splitAfterFlush(body: Buffer): { header: Buffer; rest: Buffer } {
  let offset = 0;
  while (offset < body.length) {
    if (!hasPktHeader(body, offset)) throw new Error(`not a pkt-line at offset ${offset}`);
    const length = Number.parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (length === 0) return { header: body.subarray(0, offset + 4), rest: body.subarray(offset + 4) };
    if (length < 4 || offset + length > body.length) throw new Error(`pkt-line length ${length} overruns the ${body.length}-byte body at offset ${offset}`);
    offset += length;
  }
  return { header: body, rest: Buffer.alloc(0) };
}
