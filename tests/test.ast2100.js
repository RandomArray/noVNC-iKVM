import Ast2100Decoder from '../core/decoders/ast2100/decoder.js';
import { BitStream } from '../core/decoders/ast2100/util.js';
import { idctFixedAan } from '../core/decoders/ast2100/idct.js';
import { ATEN_QT_LUMA, DCTSIZE2 } from '../core/decoders/ast2100/const.js';

// Convert a hex string, optionally containing spaces, into an array of integers representing bytes.
function parseHex(s) {
    s = s.replace(/\s/g, '');
    if (s.length % 2 != 0) {
        throw new Error('Hex data has uneven length!');
    }
    const bytes = [];
    for (let i = 0; i < s.length; i += 2) {
        bytes.push(parseInt(s.substr(i, 2), 16));
    }
    return bytes;
}

function makeDecoder() {
    return new Ast2100Decoder({
        width: 0x400,
        height: 0x300,
        blitCallback: () => {}
    });
}

// Swap u32 byte order.  Mutates input!
function bufSwap32(data) {
    for (let i = 0; i < data.length; i += 4) {
        let tmp;

        tmp = data[i+0];
        data[i+0] = data[i+3];
        data[i+3] = tmp;

        tmp = data[i+1];
        data[i+1] = data[i+2];
        data[i+2] = tmp;
    }

    return data;
}

describe('ATEN AST2100 video decoder', function () {
    let dec;

    beforeEach(function () {
        dec = makeDecoder();
    });

    describe('BitStream', function () {
        let stream, stream2, stream3;
        const data = bufSwap32(parseHex('f0f0 cccc cccc cccc cccc cccc cccc cccc'));
        const data2 = parseHex('F0F1F2F3 F4F5F6F7 F8F9FAFB FCFDFEFF');
        const data3 = parseHex('0b0b01bc45fbc5e020040101ffff3f20c0ffffff0000240000000000000000005028140a0000000000000000');

        beforeEach(function () {
            stream = new BitStream({data: data});
            stream2 = new BitStream({data: data2});
            stream3 = new BitStream({data: data3});
        });

        it('should pass simple sanity checks', function () {
            expect(stream.read(4)).to.equal(0xF);
            expect(stream.read(4)).to.equal(0x0);
            expect(stream.read(4)).to.equal(0xF);
            expect(stream.read(4)).to.equal(0x0);
        });

        it('should pass simple sanity checks (part II)', function () {
            for (let i = 0; i < 4; ++i) {
                expect(stream.read(1)).to.equal(1);
            }
            for (let i = 0; i < 4; ++i) {
                expect(stream.read(1)).to.equal(0);
            }
        });

        it('should be able to properly refill the buffer', function () {
            expect(stream.read(4)).to.equal(0xF);
            expect(stream.read(4)).to.equal(0x0);
            expect(stream.read(4)).to.equal(0xF);
            expect(stream.read(8)).to.equal(0x0C);
        });

        it('should properly swap byte order', function () {
            expect(stream2.read(8)).to.equal(0xF3);
            expect(stream2.read(8)).to.equal(0xF2);
            expect(stream2.read(8)).to.equal(0xF1);
            expect(stream2.read(8)).to.equal(0xF0);
            expect(stream2.read(8)).to.equal(0xF7);
        });

        it('should properly handle skipping the full 32-bit read-buffer (data3)', function () {
            // Must do this in two parts so that bits < 32 each time.
            stream3.skip(16);
            stream3.skip(16);
            expect(stream3.read(4)).to.equal(0xE);
        });

        // Commented out in the original test suite (an unresolved issue
        // reproduction); kept disabled. Note that read(31) on this data does
        // not account for the dword byte swapping.
        it.skip('issue repro', function () {
            const data = parseHex('f0f0 cccc cccc cccc cccc cccc cccc cccc');
            const stream = new BitStream({data: data});
            expect(stream.read(31)).to.equal(0xF0F0CCCC >>> 1);
            expect(stream.read(8)).to.equal(0x66);
        });
    });

    describe('quant tables', function () {
        it('quant tables are properly loaded and scaled', function () {
            // This is luma quant table #4.
            const expected = Int32Array.from([
                0x00090000, 0x0008527e, 0x00068866, 0x000a9537, 0x000d0000, 0x00114908, 0x000f274b, 0x0009616d,
                0x0008527e, 0x000b8b14, 0x000caf8f, 0x00104f53, 0x00136b26, 0x0022df8f, 0x0018c594, 0x000b7b02,
                0x0009255c, 0x000caf8f, 0x000f5d2c, 0x0013f8fd, 0x001cbe90, 0x0020d994, 0x001adebc, 0x000b2cc4,
                0x00083b2b, 0x000eadca, 0x00126faf, 0x00161f78, 0x0020ecad, 0x002c58a1, 0x001ca316, 0x000b07c7,
                0x000a0000, 0x0010a4fc, 0x001a219a, 0x002473bf, 0x00260000, 0x002fed69, 0x001ed922, 0x000bdd19,
                0x000a36ca, 0x0014b4bd, 0x001ecbfa, 0x00214279, 0x00235b34, 0x0023cdea, 0x001ac9de, 0x000b0e2f,
                0x000e9cbf, 0x001b0616, 0x001e67d4, 0x001e8bd4, 0x001ed922, 0x001cea24, 0x00139fb4, 0x00085c96,
                0x000b0935, 0x00138450, 0x00131afd, 0x0011d7e1, 0x001161b4, 0x000c23a7, 0x000882d0, 0x00042fc6
            ]);

            dec._loadQuantTable(0, ATEN_QT_LUMA[4]);
            const lumaQuantTable = dec.quantTables[0];
            expect(lumaQuantTable).to.deep.equal(expected);
        });
    });

    describe('IDCT', function () {
        let outputBuf;

        beforeEach(function () {
            outputBuf = new Uint8Array(DCTSIZE2);  // equivalent to one of the componentBufs in Ast2100Decoder.
        });

        it('test case 0 - DC value only', function () {
            // This is the output of the VLC / entropy coding process.
            // (Plain array, as in the original test, so 0xFF9C is a large
            // positive value rather than a negative int16.)
            const dataUnit = [
                0xFF9C, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

            const expected = new Uint8Array(64).fill(0xF);

            dec._loadQuantTable(0, ATEN_QT_LUMA[4]);
            const lumaQuantTable = dec.quantTables[0];

            idctFixedAan(lumaQuantTable, dataUnit, outputBuf);

            expect(outputBuf).to.deep.equal(expected);
        });

        // The original test compared with a tolerance of 1 ("XXX: TEMPORARY
        // -- figure out this rounding issue"); that tolerance is kept.
        it('test case 1', function () {
            const dataUnit = Int16Array.from([
                0xFFBD, 0, 0, 0, 0, 0, 0, 0,
                0xFFC3, 0, 0, 0, 0, 0, 0, 0,
                0x26, 0, 0, 0, 0, 0, 0, 0,
                0xFFED, 0, 0, 0, 0, 0, 0,
                0, 0, 0, 0, 0, 0, 0, 0, 0,
                6, 0, 0, 0, 0, 0, 0, 0,
                0xFFFC, 0, 0, 0, 0, 0, 0, 0,
                2, 0, 0, 0, 0, 0, 0, 0]);

            const expected = Uint8Array.from([
                0xF, 0xF, 0xF, 0xF, 0xF, 0xF, 0xF, 0xF,
                0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11,
                0x12, 0x12, 0x12, 0x12, 0x12, 0x12, 0x12, 0x12,
                0xE, 0xE, 0xE, 0xE, 0xE, 0xE, 0xE, 0xE,
                0x12, 0x12, 0x12, 0x12, 0x12, 0x12, 0x12, 0x12,
                0xF, 0xF, 0xF, 0xF, 0xF, 0xF, 0xF, 0xF,
                0x9F, 0x9F, 0x9F, 0x9F, 0x9F, 0x9F, 0x9F, 0x9F,
                0xA1, 0xA1, 0xA1, 0xA1, 0xA1, 0xA1, 0xA1, 0xA1]);

            dec._loadQuantTable(0, ATEN_QT_LUMA[4]);
            const lumaQuantTable = dec.quantTables[0];

            idctFixedAan(lumaQuantTable, dataUnit, outputBuf);

            let maxErr = 0;
            for (let i = 0; i < 64; ++i) {
                maxErr = Math.max(maxErr, Math.abs(outputBuf[i] - expected[i]));
            }
            expect(maxErr).to.be.at.most(1);
        });

        it('test case 2', function () {
            const dataUnit = Int16Array.from([
                0xFF9B, 0, 0, 0, 0, 0, 0, 0, 0xFFA4, 0, 0, 0, 0, 0, 0, 0, 0x35, 0, 0, 0, 0, 0, 0, 0,
                0xFFE6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 0xFFFA,
                0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]);

            const expected = [
                0xE, 0xE, 0xE, 0xE, 0xE, 0xE, 0xE, 0xE, 0x13, 0x13, 0x13, 0x13, 0x13, 0x13, 0x13, 0x13,
                0xD, 0xD, 0xD, 0xD, 0xD, 0xD, 0xD, 0xD, 0x13, 0x13, 0x13, 0x13, 0x13, 0x13, 0x13, 0x13,
                0xD, 0xD, 0xD, 0xD, 0xD, 0xD, 0xD, 0xD, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14,
                0x9C, 0x9C, 0x9C, 0x9C, 0x9C, 0x9C, 0x9C, 0x9C, 0xA1, 0xA1, 0xA1, 0xA1, 0xA1, 0xA1, 0xA1, 0xA1];

            // Between IDCT passes, the workspace should look like this:
            //  [-903, 0, 0, 0, 0, 0, 0, 0, -874, 0, 0, 0, 0, 0, 0, 0, -914, 0, 0, 0, 0, 0, 0, 0, -874, 0, 0, 0, 0, 0, 0, 0,
            //   -915, 0, 0, 0, 0, 0, 0, 0, -868, 0, 0, 0, 0, 0, 0, 0, 230, 0, 0, 0, 0, 0, 0, 0, 266, 0, 0, 0, 0, 0, 0, 0]

            dec._loadQuantTable(0, ATEN_QT_LUMA[5]);
            const lumaQuantTable = dec.quantTables[0];

            idctFixedAan(lumaQuantTable, dataUnit, outputBuf);

            let maxErr = 0;
            for (let i = 0; i < 64; ++i) {
                maxErr = Math.max(maxErr, Math.abs(outputBuf[i] - expected[i]));
            }
            expect(maxErr).to.be.at.most(1);
        });
    });

    describe('VQ', function () {
        it('should successfully load a codebook (colors)', function () {
            let data = bufSwap32(parseHex('bc010b0b e0c5fb45 01010420 203fffff ffffffc0 00240000 00000000 00000000 0a142850'));
            data = data.slice(4);  // Strip off quant table selectors and subsampling mode.

            const stream = new BitStream({data: data});
            const controlFlag = stream.read(4);
            expect(controlFlag).to.equal(0xE);

            const xMcuPos = stream.read(8), yMcuPos = stream.read(8);
            expect(xMcuPos).to.equal(0xC);
            expect(yMcuPos).to.equal(0x5F);

            dec.subsamplingMode = 444;  // required or an assertion in the VQ code will fail
            dec._stream = stream;
            dec._parseVqBlock(1);  // codewordSize=1
            expect(dec._vqCodewordLookup).to.deep.equal([1, 0, 2, 3]);
            expect(dec._vqCodebook).to.deep.equal([
                [0x10, 0x80, 0x80],
                [0xA2, 0x80, 0x80],
                [0x80, 0x80, 0x80],
                [0xC0, 0x80, 0x80]
            ]);
        });

        it('should correctly handle multiple data blocks', function () {
            // This data is from a memory dump.  It should contain two VQ (0xE-type) blocks and then an 0x9 (end-frame).
            const data = bufSwap32(parseHex('bc010b0b e0c5fb45 01010420 203fffff ffffffc0 00240000 00000000 00000000 0a142850' + '00000000 00000000'));
            // TODO (from original): improve asserts beyond just 'finished without error'
            expect(() => dec.decode(data)).to.not.throw();
        });
    });

    describe('Full JPEG subsampled MCU example 0', function () {
        // Corresponds to whole-mcu-example / main_mcu_test_2()
        const data = parseHex('040701a61bff6280f81fbaa2ff4dbc408dfccf405c15ff1f004800f500000000000000002dd4a462237ced2c9c25dca4cef7e6667d6626f3308063c3c7a1b7335badc24aaf0b5e9daf69590fcb96206b59e6f2ccb2bdd386b17dbb72182080d6288a2a1f2f0608a0fe87ae287f132f1023ff33d057c5ff470012403d0000000000000000ec1fb06cdacd2bdf9d79f3cde7f9f1362b7ce914ba521c79524a5bdc212a5ed47c3cbc6c7e072ae3e3c18384785f6ca6d4e22fb1af0c96449d1847a9c7037e966fa3ac8d4990830339463d277f25fc6f30ffe5f4f5cfec9f4ffff8bf00a0f5d358a2ab6e4e6778d929f686bd58ca9c26b8f7338f15105065dd39c718e219a78e');

        it('should decode properly', function () {
            // DOES NOT APPEAR TO correspond to the notes in 'whole-mcu-example.txt' (from original).
            // The original only checked that decoding finishes without error.
            expect(() => dec.decode(data)).to.not.throw();
        });
    });

    describe('Full JPEG subsampled MCU example 1', function () {
        // TODO (from original): this looks VERY SIMILAR to the above example
        const data = parseHex('040701a61bff6280f81fbaa2ff4dbc408dfccf405c15ff1f004800f500000000000000002dd4a462237ced2c9c25dca4cef7e6667d6626f3308063c3c7a1b7335badc24aaf0b5e9daf69590fcb96206b59e6f2ccb2bdd386b17dbb72182080d6288a2a1f2f0608a0fe87ae287f132f1023ff33d057c5ff470012403d0000000000000000ec1fb06cdacd2bdf9d79f3cde7f9f1362b7ce914ba521c79524a5bdc212a5ed47c3cbc6c7e072ae3e3c18384785f6ca6d4e22fb1af0c96449d1847a9c7037e966fa3ac8d4990830339463d277f25fc6f30ffe5f4f5cfec9f4ffff8bf00a0f5d358a2ab6e4e6778d929f686bd58ca9c26b8f7338f15105065dd39c718');

        // Commented out in the original test suite; kept disabled.
        it.skip('should load quant tables and set subsamplingMode', function () {
            dec.decode(data);

            expect(dec._loadedQuantTables[0]).to.equal(4);
            expect(dec._loadedQuantTables[1]).to.equal(7);
            expect(dec.subsamplingMode).to.equal(422);
        });

        it('should decode properly', function () {
            // DOES NOT APPEAR TO correspond to the notes in 'whole-mcu-example.txt' (from original).
            // The original only checked that decoding finishes without error.
            expect(() => dec.decode(data)).to.not.throw();
        });
    });

    describe('Full frame decode test', function () {
        it('should decode a full 1024x768 frame into a real image', async function () {
            const response = await fetch('/base/tests/frame4.hex');
            const data = parseHex(await response.text());
            const covered = new Set();
            const colors = new Set();
            const full = new Ast2100Decoder({
                width: 1024, height: 768,
                blitCallback: (x, y, w, h, buf) => {
                    covered.add(x + ',' + y);
                    for (let i = 0; i < w * h * 4; i += 4) {
                        colors.add((buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]);
                    }
                },
            });
            full.decode(data);
            // Every 8x8 block of the screen gets drawn, and it isn't blank
            expect(covered.size).to.equal((1024 / 8) * (768 / 8));
            expect(colors.size).to.be.above(16);
        });
    });

    describe('Frame update decode test', function () {
        it('should decode properly', function () {
            // (from original) this data should NOT be solid-white!
            // The original only checked that decoding finishes without error.
            const data = parseHex('050501a69a3f6080008aa2a8000000900000000000000000');
            expect(() => dec.decode(data)).to.not.throw();
        });
    });
});
