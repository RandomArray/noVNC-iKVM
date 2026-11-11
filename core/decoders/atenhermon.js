/*
 * noVNC-iKVM: ATEN iKVM "Hermon" encoding (0x59)
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * Used by Supermicro X7/X8/X9 (WPCM450 "Hermon") and some AST2400 BMCs.
 *
 * Every ATEN rectangle starts with an 8 byte prelude:
 *   u32 flags (meaning unknown), u32 length of the data that follows
 * If length > 0 the data starts with a 10 byte header:
 *   u8 type, u8 padding, u32 segments, u32 length (repeats the prelude length)
 * type 0: "segments" 16x16 tiles, each:
 *   u16 ?, u16 ?, u8 row, u8 column, 16*16 pixels
 * type 1: raw full frame, width*height pixels
 * Pixels are 16 bit little endian RGB555, whatever ServerInit claims.
 */

const TILE = 16;
const TILE_BYTES = TILE * TILE * 2;
const SEGMENT_BYTES = 6 + TILE_BYTES;

export const ATEN_TYPE_SEGMENTS = 0;
export const ATEN_TYPE_RAW = 1;

// RGB555 (little endian) -> RGBX
export function rgb555ToRGBX(src, srcOffset, dst, dstOffset, pixels) {
    for (let i = 0; i < pixels; i++) {
        const v = src[srcOffset + i * 2] | (src[srcOffset + i * 2 + 1] << 8);
        const r = (v >> 10) & 0x1f;
        const g = (v >> 5) & 0x1f;
        const b = v & 0x1f;
        const o = dstOffset + i * 4;
        dst[o] = (r << 3) | (r >> 2);
        dst[o + 1] = (g << 3) | (g >> 2);
        dst[o + 2] = (b << 3) | (b >> 2);
        dst[o + 3] = 255;
    }
}

export default class AtenHermonDecoder {
    constructor() {
        this._reset();
        this._tileBuf = new Uint8Array(TILE * TILE * 4);
        this._lineBuf = new Uint8Array(0);
    }

    _reset() {
        this._len = -1;       // bytes left in this rect, -1 = prelude not read
        this._type = -1;
        this._segments = 0;
        this._lines = 0;
    }

    decodeRect(x, y, width, height, sock, display, depth) {
        if (this._len === -1) {
            if (sock.rQwait("ATEN prelude", 8)) { return false; }
            sock.rQskipBytes(4);  // flags
            this._len = sock.rQshift32();
            if (this._len === 0) {
                this._reset();
                return true;
            }
        }

        if (this._type === -1) {
            if (sock.rQwait("ATEN Hermon header", 10)) { return false; }
            this._type = sock.rQshift8();
            sock.rQskipBytes(1);
            this._segments = sock.rQshift32();
            const len = sock.rQshift32();
            if (len !== this._len) {
                throw new Error("ATEN Hermon length mismatch (" + len +
                                " != " + this._len + ")");
            }
            this._len -= 10;
            if (this._type === ATEN_TYPE_RAW) {
                if (this._len !== width * height * 2) {
                    throw new Error("ATEN Hermon raw frame has unexpected size " +
                                    this._len + " for " + width + "x" + height);
                }
                this._lines = height;
            } else if (this._type === ATEN_TYPE_SEGMENTS) {
                if (this._len !== this._segments * SEGMENT_BYTES) {
                    throw new Error("ATEN Hermon segment data has unexpected size " +
                                    this._len + " for " + this._segments + " segments");
                }
            } else {
                throw new Error("Unknown ATEN Hermon type " + this._type);
            }
        }

        if (this._type === ATEN_TYPE_RAW) {
            const lineBytes = width * 2;
            if (this._lineBuf.length < width * 4) {
                this._lineBuf = new Uint8Array(width * 4);
            }
            while (this._lines > 0) {
                if (sock.rQwait("ATEN Hermon raw", lineBytes)) { return false; }
                const data = sock.rQshiftBytes(lineBytes, false);
                rgb555ToRGBX(data, 0, this._lineBuf, 0, width);
                display.blitImage(x, y + height - this._lines, width, 1,
                                  this._lineBuf, 0);
                this._lines--;
            }
        } else {
            while (this._segments > 0) {
                if (sock.rQwait("ATEN Hermon segment", SEGMENT_BYTES)) { return false; }
                sock.rQskipBytes(4);
                const row = sock.rQshift8();
                const col = sock.rQshift8();
                const data = sock.rQshiftBytes(TILE_BYTES, false);
                const tx = x + col * TILE;
                const ty = y + row * TILE;
                // Clip tiles that hang over the edge of the screen
                const tw = Math.min(TILE, x + width - tx);
                const th = Math.min(TILE, y + height - ty);
                if (tw > 0 && th > 0) {
                    rgb555ToRGBX(data, 0, this._tileBuf, 0, TILE * TILE);
                    if (tw === TILE && th === TILE) {
                        display.blitImage(tx, ty, TILE, TILE, this._tileBuf, 0);
                    } else {
                        const clipped = new Uint8Array(tw * th * 4);
                        for (let r = 0; r < th; r++) {
                            clipped.set(this._tileBuf.subarray(r * TILE * 4,
                                                               r * TILE * 4 + tw * 4),
                                        r * tw * 4);
                        }
                        display.blitImage(tx, ty, tw, th, clipped, 0);
                    }
                }
                this._segments--;
            }
        }

        this._reset();
        return true;
    }
}
