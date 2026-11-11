/*
 * noVNC: HTML5 VNC client
 * AST2100 (ATEN iKVM) video decoder
 * (c) Copyright 2015-2016 Kevin Kelley <kelleyk@kelleyk.net>.
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * Decodes the JPEG-like (DCT) and VQ-compressed frame data produced by the
 * ASPEED AST2100 video engine used by ATEN/Supermicro iKVM consoles.  Output
 * is delivered in 8x8 pixel blocks of RGBX (4 bytes/pixel) data through the
 * blitCallback.
 */

import * as Log from '../../util/logging.js';

import {
    DCTSIZE2, ZIGZAG_ORDER, AAN_IDCT_SCALING_FACTORS,
    ATEN_QT_LUMA, ATEN_QT_CHROMA, TABLE_CLASS_AC, TABLE_CLASS_DC,
    BITS_AC_LUMA, BITS_AC_CHROMA, BITS_DC_LUMA, BITS_DC_CHROMA,
    HUFFVAL_AC_LUMA, HUFFVAL_AC_CHROMA, HUFFVAL_DC_LUMA, HUFFVAL_DC_CHROMA,
    YUVTORGB_Y_TABLE, YUVTORGB_CR_R_TABLE, YUVTORGB_CR_G_TABLE,
    YUVTORGB_CB_G_TABLE, YUVTORGB_CB_B_TABLE,
} from './const.js';
import { idctFixedAan } from './idct.js';
import { BitStream, JpegHuffmanTable, inRangeIncl, clamp } from './util.js';

function hex(x, width) {
    return x.toString(16).padStart(width, '0');
}

export default class Ast2100Decoder {
    constructor(defaults) {
        this._blitCallback = defaults.blitCallback;
        this._videoSettingsChangedCallback = defaults.videoSettingsChangedCallback;
        this._frameWidth = defaults.width;
        this._frameHeight = defaults.height;

        if (!this._frameWidth || !this._frameHeight) {
            throw new Error('Missing required parameter: width, height');
        }

        // Either 444 or 422 (though the "422" mode is really 4:2:0, where chroma is subsampled by a factor of two in
        // each direction).  Applies only to JPEG-ish blocks, not to VQ blocks; but VQ blocks seem to only appear in
        // 4:4:4 color mode.
        this.subsamplingMode = -1;

        this.quantTables = [new Int32Array(64), new Int32Array(64)];
        this._loadedQuantTables = [-1, -1];

        this.huffTables = [
            [new JpegHuffmanTable({bits: BITS_DC_LUMA, huffval: HUFFVAL_DC_LUMA}),
             new JpegHuffmanTable({bits: BITS_DC_CHROMA, huffval: HUFFVAL_DC_CHROMA})],
            [new JpegHuffmanTable({bits: BITS_AC_LUMA, huffval: HUFFVAL_AC_LUMA}),
             new JpegHuffmanTable({bits: BITS_AC_CHROMA, huffval: HUFFVAL_AC_CHROMA})],
        ];

        this._scanComponents = [
            {huffTableSelectorDC: 0, huffTableSelectorAC: 0},  // Y
            {huffTableSelectorDC: 1, huffTableSelectorAC: 1},  // Cb
            {huffTableSelectorDC: 1, huffTableSelectorAC: 1}   // Cr
        ];
        this._scanPrevDc = [0, 0, 0];

        this._mcuPosX = 0;
        this._mcuPosY = 0;

        this._initializeVq();

        // Allocate memory here once and then re-use it.
        // These buffers store data after entropy decoding (Huffman, zigzag) and before we dequant and apply the IDCT.
        this._tmpBufY = [
            new Int16Array(DCTSIZE2),
            new Int16Array(DCTSIZE2),
            new Int16Array(DCTSIZE2),
            new Int16Array(DCTSIZE2)];
        this._tmpBufCb = new Int16Array(DCTSIZE2);
        this._tmpBufCr = new Int16Array(DCTSIZE2);
        // These buffers store IDCT output.
        this._componentBufY = [
            new Uint8Array(DCTSIZE2),
            new Uint8Array(DCTSIZE2),
            new Uint8Array(DCTSIZE2),
            new Uint8Array(DCTSIZE2)];
        this._componentBufCb = new Uint8Array(DCTSIZE2);
        this._componentBufCr = new Uint8Array(DCTSIZE2);
        // The final RGB output goes here; each group of four elements represents one RGBX pixel.
        this._outputBuf = new Uint8Array(DCTSIZE2 * 4);
    }

    // Change the frame's size.
    setSize(width, height) {
        if (this._frameWidth != width || this._frameHeight != height) {
            Log.Debug('Ast2100Decoder: frame size changed to ' + width + 'x' + height);
        }
        this._frameWidth = width;
        this._frameHeight = height;
    }

    // Each quant table selector is between 0x0 (lowest quality) and 0xB (highest quality).  The ATEN client shows a
    // single quality slider, which changes both values in tandem.  The server sends all three values with each
    // FramebufferUpdate message, so these values are updated with every call to decode().  They will be -1 before
    // the first frame is decoded.
    getVideoSettings() {
        return {
            quantTableSelectorLuma: this._loadedQuantTables[0],
            quantTableSelectorChroma: this._loadedQuantTables[1],
            subsamplingMode: this.subsamplingMode
        };
    }

    decode(data) {
        // Reset state that must be reset between frames.
        this._scanPrevDc = [0, 0, 0];
        this._mcuPosX = 0;
        this._mcuPosY = 0;

        // First four bytes.
        const quantTableSelectorLuma = data[0];  // 0 <= x <= 0xB
        const quantTableSelectorChroma = data[1];  // 0 <= x <= 0xB
        const subsamplingMode = (data[2] << 8) | data[3];  // 422 or 444

        let changedSettings = false;
        if (this.subsamplingMode != subsamplingMode) {
            Log.Debug('Ast2100Decoder: new subsampling mode: ' + subsamplingMode);
            this.subsamplingMode = subsamplingMode;
            changedSettings = true;
        }
        if (quantTableSelectorLuma != this._loadedQuantTables[0]) {
            if (!inRangeIncl(quantTableSelectorLuma, 0, 0xB)) {
                throw new Error('Out-of-range selector for luma quant table: ' + quantTableSelectorLuma.toString(16));
            }
            Log.Debug('Ast2100Decoder: loading new luma quant table: ' + hex(quantTableSelectorLuma, 2));
            this._loadQuantTable(0, ATEN_QT_LUMA[quantTableSelectorLuma]);
            this._loadedQuantTables[0] = quantTableSelectorLuma;
            changedSettings = true;
        }
        if (quantTableSelectorChroma != this._loadedQuantTables[1]) {
            if (!inRangeIncl(quantTableSelectorChroma, 0, 0xB)) {
                throw new Error('Out-of-range selector for chroma quant table: ' + quantTableSelectorChroma.toString(16));
            }
            Log.Debug('Ast2100Decoder: loading new chroma quant table: ' + hex(quantTableSelectorChroma, 2));
            this._loadQuantTable(1, ATEN_QT_CHROMA[quantTableSelectorChroma]);
            this._loadedQuantTables[1] = quantTableSelectorChroma;
            changedSettings = true;
        }

        if (this.subsamplingMode != 422 && this.subsamplingMode != 444) {
            throw new Error('Unexpected value for subsamplingMode: 0x' + hex(this.subsamplingMode, 4));
        }

        if (changedSettings && this._videoSettingsChangedCallback) {
            this._videoSettingsChangedCallback(this.getVideoSettings());
        }

        // The remainder of the stream is byte-swapped in four-byte chunks.  BitStream takes care of this.
        this._stream = new BitStream({data: data});
        this._stream.skip(16);
        this._stream.skip(16);  // do this in two parts because bits must be < 32

        while (true) {
            const controlFlag = this._stream.read(4);  // uint4

            if (controlFlag == 0 || controlFlag == 4 || controlFlag == 8 || controlFlag == 0xC) {
                // JPEG-ish (DCT-compressed) data.

                if (controlFlag == 8 || controlFlag == 0xC) {
                    this._mcuPosX = this._stream.read(8);  // uint8
                    this._mcuPosY = this._stream.read(8);  // uint8
                }

                if (controlFlag == 4 || controlFlag == 0xC) {
                    // Haven't seen traffic where this feature is used yet.
                    throw new Error('Unexpected control flag: alternate quant table');
                }

                // In 4:2:0 ("422") mode, we'll read 6 blocks (4 Y, 1 Cb, 1 Cr) and produce a block of 16x16
                // pixels; in 4:4:4 mode, 3 blocks producing 8x8 pixels.
                this._parseMcu();

            } else if (inRangeIncl(controlFlag, 5, 7) || inRangeIncl(controlFlag, 0xD, 0xF)) {
                // VQ-compressed data.

                if (controlFlag >= 0xD) {
                    this._mcuPosX = this._stream.read(8);  // uint8
                    this._mcuPosY = this._stream.read(8);  // uint8
                }

                const codewordSize = (controlFlag & 7) - 5;  // 0 <= codewordSize <= 2
                this._parseVqBlock(codewordSize);

            } else if (controlFlag == 9) {
                // Done with frame!
                break;
            } else {
                throw new Error('Unexpected control flag: unknown value 0x' + hex(controlFlag, 2));
            }
        }
    }

    _getMcuSize() {
        return {444: 8, 422: 16}[this.subsamplingMode];
    }

    // Bakes in C(u)*C(v) and the cosine terms (from the IDCT formula).
    _loadQuantTable(slot, srcTable) {
        for (let y = 0; y < 8; ++y) {
            for (let x = 0; x < 8; ++x) {
                this.quantTables[slot][y*8+x] = ~~(srcTable[y*8+x] * AAN_IDCT_SCALING_FACTORS[x] * AAN_IDCT_SCALING_FACTORS[y] * 65536.0);
            }
        }
    }

    _initializeVq() {
        // These colors are in YCbCr, so they're just black, white, and two shades of grey.
        this._vqCodewordLookup = [0, 1, 2, 3];
        this._vqCodebook = [
            [0x00, 0x80, 0x80],
            [0xFF, 0x80, 0x80],
            [0x80, 0x80, 0x80],
            [0xC0, 0x80, 0x80]
        ];
    }

    // Update our position variables to point at the next MCU.
    _advancePosition() {
        const mcuSize = this._getMcuSize();
        let widthInMcus = ~~(this._frameWidth / mcuSize);
        if (this._frameWidth % mcuSize != 0) {
            widthInMcus += 1;
        }
        let heightInMcus = ~~(this._frameHeight / mcuSize);
        if (this._frameHeight % mcuSize != 0) {
            heightInMcus += 1;
        }

        this._mcuPosX += 1;
        if (this._mcuPosX >= widthInMcus) {
            this._mcuPosX = 0;
            this._mcuPosY += 1;
        }
        if (this._mcuPosY >= heightInMcus) {
            this._mcuPosY = 0;
        }
    }

    // - Always 8x8, since chroma subsampling does not apply to VQ-compressed data.  (As a consequence, VQ blocks
    //   only seem to appear when DCT chroma subsampling is disabled; that is, in "444" mode.)
    // - Reads 64 * codewordSize bits from the input stream.
    _parseVqBlock(codewordSize) {
        const mcuSize = this._getMcuSize();
        if (mcuSize != 8) {
            throw new Error('Unexpected MCU size for VQ block!');
        }
        if (!inRangeIncl(codewordSize, 0, 2)) {
            throw new Error('Out-of-range codewordSize!');
        }

        const yBuf = this._componentBufY[0];
        const cbBuf = this._componentBufCb;
        const crBuf = this._componentBufCr;

        const setColor = (j, codeword) => {
            const color = this._vqCodebook[this._vqCodewordLookup[codeword]];
            yBuf[j] = color[0];
            cbBuf[j] = color[1];
            crBuf[j] = color[2];
        };

        // Read new codebook data.  (That is: new colors for each of our codewords (the values we'll read from the
        // input data) to map to.)
        for (let i = 0; i < (1 << codewordSize); ++i) {
            // Read 1b flag and 2b codebook slot number.  if flag is set, read 24b RGB value and set colors[slot #].
            // Regardless (?), set the ith codeword to map to this slot.
            const hasNewColor = this._stream.read(1);
            const codebookSlotIdx = this._stream.read(2);
            if (hasNewColor) {
                const color = [this._stream.read(8), this._stream.read(8), this._stream.read(8)];  // Y, Cb, Cr
                this._vqCodebook[codebookSlotIdx] = color;
            }
            this._vqCodewordLookup[i] = codebookSlotIdx;
        }

        // Read a block of image data.
        if (codewordSize == 0) {
            // Act as though we've got a single-entry codebook.
            for (let i = 0; i < 64; ++i) {
                setColor(i, 0);
            }
        } else {
            for (let i = 0; i < 64; ++i) {
                setColor(i, this._stream.read(codewordSize));
            }
        }

        // Perform colorspace conversion and copy into destination image buffer.
        for (let j = 0; j < 64; ++j) {
            this._ycbcrToRgb(this._outputBuf, j, this._componentBufY[0][j], this._componentBufCb[j], this._componentBufCr[j]);
        }

        this._blitCallback(8 * this._mcuPosX, 8 * this._mcuPosY, 8, 8, this._outputBuf);

        this._advancePosition();
    }

    _parseMcu() {
        const qtLuma = this.quantTables[0];
        const qtChroma = this.quantTables[1];

        this._parseDataUnit(0, this._tmpBufY[0]);
        idctFixedAan(qtLuma, this._tmpBufY[0], this._componentBufY[0]);
        if (this.subsamplingMode != 444) {
            this._parseDataUnit(0, this._tmpBufY[1]);
            idctFixedAan(qtLuma, this._tmpBufY[1], this._componentBufY[1]);
            this._parseDataUnit(0, this._tmpBufY[2]);
            idctFixedAan(qtLuma, this._tmpBufY[2], this._componentBufY[2]);
            this._parseDataUnit(0, this._tmpBufY[3]);
            idctFixedAan(qtLuma, this._tmpBufY[3], this._componentBufY[3]);
        }
        this._parseDataUnit(1, this._tmpBufCb);
        idctFixedAan(qtChroma, this._tmpBufCb, this._componentBufCb);
        this._parseDataUnit(2, this._tmpBufCr);
        idctFixedAan(qtChroma, this._tmpBufCr, this._componentBufCr);

        if (this.subsamplingMode != 444) {
            // 4:2:0 subsampling (x2 in each direction), or what ATEN calls "422" (even though it's not).
            // N.B.: dx selects the block row and dy the block column here; the naming is inherited from the
            // original code, and the arithmetic below is consistent with it.
            for (let dy = 0; dy < 2; ++dy) {
                for (let dx = 0; dx < 2; ++dx) {
                    // for each of the four blocks in this MCU
                    const componentBufY = this._componentBufY[dx*2+dy];
                    for (let y = 0; y < 8; ++y) {
                        for (let x = 0; x < 8; ++x) {
                            const hy = ~~((8*dx+y)/2);
                            const hx = ~~((8*dy+x)/2);
                            this._ycbcrToRgb(this._outputBuf, y*8+x, componentBufY[y*8+x], this._componentBufCb[hy*8+hx], this._componentBufCr[hy*8+hx]);
                        }
                    }
                    this._blitCallback(16 * this._mcuPosX + 8 * dy, 16 * this._mcuPosY + 8 * dx, 8, 8, this._outputBuf);
                }
            }
        } else {
            // No subsampling.
            for (let j = 0; j < 64; ++j) {
                this._ycbcrToRgb(this._outputBuf, j, this._componentBufY[0][j], this._componentBufCb[j], this._componentBufCr[j]);
            }
            this._blitCallback(8 * this._mcuPosX, 8 * this._mcuPosY, 8, 8, this._outputBuf);
        }

        this._advancePosition();
    }

    _parseDataUnit(componentIdx, buf) {
        const scanComponent = this._scanComponents[componentIdx];
        const dcHufftable = this.huffTables[TABLE_CLASS_DC][scanComponent.huffTableSelectorDC];
        const acHufftable = this.huffTables[TABLE_CLASS_AC][scanComponent.huffTableSelectorAC];

        const setValue = (i, val) => {
            buf[ZIGZAG_ORDER[i]] = val;
        };

        // First element is the DC component, followed by 63 AC components.  The DC component is encoded slightly
        // differently than the AC components: it is stored as the delta between the value and the last DC component
        // from the same component.
        const dcDelta = this._readEncodedValueDC(dcHufftable);
        this._scanPrevDc[componentIdx] += dcDelta;
        buf[0] = this._scanPrevDc[componentIdx];

        // Read the AC components.
        for (let i = 1; i < 64;) {
            const x = acHufftable.readCode(this._stream);

            // See ITU T.81 p89 (e.g. Fig F.1).
            // runlen is runlength of zeroes; if size==0, runlen==0 means EOB and runlen==15 means ZRL.
            // size is number of bits required to represent the amplitude that follows the codeword.
            const runlen = x >>> 4;
            const size = x & 0x0F;

            if (size == 0) {
                if (runlen == 0) {  // special EOB (end-of-block) codeword; fill remainder with zeroes
                    while (i < 64) {
                        setValue(i, 0);
                        ++i;
                    }
                    break;
                } else if (runlen == 0xF) {  // special ZRL (zero-run-length) codeword; emit sixteen zeroes
                    for (let j = 0; j < 16; ++j) {
                        setValue(i + j, 0);
                    }
                    i += 16;
                    continue;
                }
            }

            // Emit runlen zero entries.
            for (let j = 0; j < runlen; ++j) {
                setValue(i + j, 0);
            }
            i += runlen;

            setValue(i, this._readEncodedValueAC(size));  // category=size
            i += 1;
        }

        return buf;
    }

    _readEncodedValueDC(huffTable) {
        const category = huffTable.readCode(this._stream);
        return this._readEncodedValueAC(category);
    }

    _readEncodedValueAC(category) {
        if (category == 0) {
            return 0;
        }

        let value;  // sint32
        const valSign = this._stream.read(1);

        if (valSign == 0) { // Negative (unlike a normal "signed int" representation).
            value = -(1 << category) + 1;
        } else {
            value = (1 << category - 1);
        }

        if (category > 1) {
            const moreBits = this._stream.read(category - 1);  // uint
            value += moreBits;
        }

        return value;
    }

    _ycbcrToRgb(outputBuf, outputOffset, y, cb, cr) {
        outputOffset *= 4;
        outputBuf[outputOffset + 0] = clamp(YUVTORGB_Y_TABLE[y] + YUVTORGB_CR_R_TABLE[cr]);
        outputBuf[outputOffset + 1] = clamp(YUVTORGB_Y_TABLE[y] + YUVTORGB_CR_G_TABLE[cr] + YUVTORGB_CB_G_TABLE[cb]);
        outputBuf[outputOffset + 2] = clamp(YUVTORGB_Y_TABLE[y] + YUVTORGB_CB_B_TABLE[cb]);
        outputBuf[outputOffset + 3] = 0xFF;  // alpha (ignored by noVNC; kept for RGBX layout)
    }
}
