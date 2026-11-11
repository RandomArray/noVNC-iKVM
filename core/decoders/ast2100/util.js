/*
 * noVNC: HTML5 VNC client
 * AST2100 (ATEN iKVM) video decoder: bit stream and Huffman helpers
 * (c) Copyright 2015-2016 Kevin Kelley <kelleyk@kelleyk.net>.
 * Licensed under MPL 2.0 (see LICENSE.txt)
 */

export function inRangeIncl(x, a, b) {
    return (x >= a && x <= b);
}

function swap32(val) {
    return ((val & 0xFF) << 24)
        | ((val & 0xFF00) << 8)
        | ((val >> 8) & 0xFF00)
        | ((val >> 24) & 0xFF);
}

export function clamp(x) {
    x = ~~x;
    if (x <= 0) {
        return 0;
    }
    if (x >= 255) {
        return 255;
    }
    return x;
}

// Reads bits MSB-first from a byte buffer whose contents are byte-swapped in
// four-byte (little-endian dword) chunks; ATEN scan data does not treat 0xFF
// bytes specially.
export class BitStream {
    constructor(defaults) {
        this._data = defaults.data;  // uint8[]
        if (this._data === undefined) {
            throw new Error('BitStream constructor requires argument "data"!');
        }

        this._nextDword = 0;  // uint8

        // Fill the readbuf and reservoir with the first two dwords in the data buffer.
        this._reservoir = 0;
        this._bitsInReservoir = 0;
        this._refill();
        this._readbuf = this._reservoir;
        this._reservoir = 0;
        this._bitsInReservoir = 0;
        this._refill();
    }

    skip(bits) {
        while (bits > 0) {
            const n = Math.min(32, bits);
            this.read(n);
            bits -= n;
        }
    }

    read(bits) {
        if (bits >= 32) {  // due to the fact that the bitwise operators have this limitation
            throw new Error('Number of bits must be less than 32.');
        }

        const retval = this._readbuf >>> (32 - bits);  // same as this.peek(bits)

        if (bits > this._bitsInReservoir) {
            bits -= this._bitsInReservoir;
            this._moveFromReservoir(this._bitsInReservoir);
            this._refill();
        }
        this._moveFromReservoir(bits);

        return retval;
    }

    peek(bits) {
        if (bits >= 32) {  // due to the fact that the bitwise operators have this limitation
            throw new Error('Number of bits must be less than 32.');
        }

        return this._readbuf >>> (32 - bits);
    }

    _moveFromReservoir(n) {
        this._readbuf = (this._readbuf << n) | (this._reservoir >>> (32 - n));
        this._reservoir <<= n;
        this._bitsInReservoir -= n;
    }

    _refill() {
        // N.B.: Must use >>> for unsigned shift; >> is sra.
        if (this._bitsInReservoir != 0) {
            throw new Error('Oops: in _refill(), bitsInReservoir=' + this._bitsInReservoir);
        }
        for (let i = 0; i < 4; ++i) {
            const x = this._data[(4 * this._nextDword) + i];
            if (x === undefined) {
                throw new Error('BitStream overran available data!');
            }
            this._reservoir = (this._reservoir << 8) | x;
            this._bitsInReservoir += 8;
        }
        this._nextDword += 1;

        this._reservoir = swap32(this._reservoir);
    }
}

export class JpegHuffmanTable {
    constructor(defaults) {
        if (!defaults) {
            defaults = {};
        }
        if (!defaults.bits || !defaults.huffval) {
            throw new Error('Arguments bits, huffval are required.');
        }

        this._huffsize = new Uint8Array(1 << 16);
        this._huffvalLookup = new Uint8Array(1 << 16);
        this._bits = new Uint8Array(17);  // 1 to 16, plus a useless 0th element to make indexing nice

        this._buildTables(defaults.bits, defaults.huffval);
    }

    _buildTables(bits, huffval) {
        // First, copy BITS.
        for (let i = 0; i < 17; ++i) {
            this._bits[i] = bits[i];

            // This follows from the fact that the all-ones codeword of each length is reserved as a prefix for longer
            // codewords, which implies that there may not be more than (2**i)-1 codewords of length i bits.
            if ((1 << i) <= bits[i]) {
                throw new Error('Oops: bad BITS.');
            }
        }

        // Calculate Huffman codewords.  The best explanation for this is a graphical one.  Refer to 'Binary Tree
        // Expansion of DHT' figure here: http://www.impulseadventure.com/photo/jpeg-huffman-coding.html.
        let nextCodeword = 0;
        let codewordIdx = 0;  // index into HUFFVAL
        for (let codeLen = 1; codeLen < 17; ++codeLen) {
            for (let i = 0; i < this._bits[codeLen]; ++i) {
                for (let j = 0; j < (1 << (16 - codeLen)); ++j) {
                    this._huffsize[nextCodeword + j] = codeLen;
                    this._huffvalLookup[nextCodeword + j] = huffval[codewordIdx];
                }
                nextCodeword += (1 << (16 - codeLen));
                codewordIdx += 1;
            }
        }
        if (codewordIdx != huffval.length) {
            throw new Error('Oops: all codewords should be used!');
        }
    }

    // Reads the next code from the stream.  Consumes up to 16 bits.  Returns the corresponding codeword (the value
    // that the code represents, which is always exactly one byte).
    readCode(stream) {
        // Some number of bits, 16 < x <= 0, on the least-significant end of this 16b value are not relevant, depending
        // on how long the code actually is.  However, we've built our lookup tables so that, regardless of what value
        // the irrelevant bits have, we will get the same result.
        const fixedlenCode = stream.peek(16);  // uint16

        const codeLen = this._huffsize[fixedlenCode];
        stream.skip(codeLen);
        return this._huffvalLookup[fixedlenCode];
    }
}
