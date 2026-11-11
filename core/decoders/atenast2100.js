/*
 * noVNC-iKVM: ATEN iKVM "AST2100" encoding (0x57)
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * Used by Supermicro X10-era BMCs (ASPEED AST2400 and friends).
 * Rect layout: u32 flags, u32 length, then `length` bytes of
 * AST2100 compressed video covering the whole screen.
 */

import Ast2100Decoder from "./ast2100/decoder.js";

export default class AtenAST2100Decoder {
    constructor() {
        this._len = -1;
        this._decoder = null;
        this._width = 0;
        this._height = 0;
        this._display = null;
        // Called with the server's current video settings
        // ({quantTableSelectorLuma, quantTableSelectorChroma, subsamplingMode})
        this.onvideosettings = () => {};
    }

    decodeRect(x, y, width, height, sock, display, depth) {
        if (this._len === -1) {
            if (sock.rQwait("ATEN prelude", 8)) { return false; }
            sock.rQskipBytes(4);  // flags
            this._len = sock.rQshift32();
        }

        if (this._len === 0) {
            this._len = -1;
            return true;
        }

        if (sock.rQwait("ATEN AST2100", this._len)) { return false; }
        const data = sock.rQshiftBytes(this._len);
        this._len = -1;

        this._display = display;
        if (this._decoder === null) {
            this._decoder = new Ast2100Decoder({
                width: width,
                height: height,
                blitCallback: (bx, by, bw, bh, buf) => {
                    this._display.blitImage(x + bx, y + by, bw, bh, buf, 0);
                },
                videoSettingsChangedCallback: (settings) => {
                    this.onvideosettings(settings);
                },
            });
            this._width = width;
            this._height = height;
        } else if (width !== this._width || height !== this._height) {
            this._decoder.setSize(width, height);
            this._width = width;
            this._height = height;
        }

        this._decoder.decode(data);
        return true;
    }
}
