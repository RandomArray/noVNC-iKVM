/*
 * noVNC: HTML5 VNC client
 * AST2100 (ATEN iKVM) video decoder: fixed-point AA&N IDCT
 * (c) Copyright 2015-2016 Kevin Kelley <kelleyk@kelleyk.net>.
 * Licensed under MPL 2.0 (see LICENSE.txt)
 */

// N.B.: These values assume CONST_BITS == 8
const FIX_1_082392200 = 277;  // fix(1.082392200)
const FIX_1_414213562 = 362;  // fix(1.414213562)
const FIX_1_847759065 = 473;  // fix(1.847759065)
const FIX_2_613125930 = 669;  // fix(2.613125930)

const CONST_BITS = 8;
const PASS1_BITS = 0;

// This isn't a libjpeg parameter; it just means that ATEN downshifts all the way back to "normal ints" at the end
// of pass 1.
const END_PASS1_DESCALE_BITS = CONST_BITS;

// This is like clamp() except that it also adds the MAXJSAMPLE/2 offset.
function rangeLimit(x) {
    x += 128;  // This is baked into the range limit table in the ATEN stuff and in libjpeg; see comment above prepare_range_limit_table() in jdmaster.c.
    return Math.max(0, Math.min(255, x));
}

function descale(x, n) {
    return x >> n;
}

// (libjpeg's non-"accurate rounding" IDESCALE)
const idescale = descale;

function fixedMul(a, b) {
    return descale(a * b, CONST_BITS);
}

function fixedDequant(scaledQuantTable, buf, i) {
    // N.B.: The data in buf is unscaled; the data in scaledQuantTable has been scaled by 1<<16.
    return fixedMul(scaledQuantTable[i], buf[i]);
}

// Columns; aka "Pass 1".
function aanIdctCol(scaledQuantTable, buf, workspace, x) {
    const dequant = idx => fixedDequant(scaledQuantTable, buf, idx);
    const mul = fixedMul;

    let allAcZero = true;
    for (let y = 1; y < 8; ++y) {
        if (buf[8 * y + x] != 0) {
            allAcZero = false;
            break;
        }
    }
    if (allAcZero) {
        const dcval = idescale(dequant(8 * 0 + x), END_PASS1_DESCALE_BITS);  // in total, >> 16
        for (let y = 0; y < 8; ++y) {
            workspace[8 * y + x] = dcval;
        }
        return;
    }

    // Even part.
    let tmp0 = dequant(8 * 0 + x);
    let tmp1 = dequant(8 * 2 + x);
    let tmp2 = dequant(8 * 4 + x);
    let tmp3 = dequant(8 * 6 + x);

    let tmp10 = tmp0 + tmp2;  // Phase 3
    let tmp11 = tmp0 - tmp2;

    const tmp13 = tmp1 + tmp3;  // Phases 5-3
    let tmp12 = mul((tmp1 - tmp3), FIX_1_414213562) - tmp13;  // 2 * c4

    tmp0 = tmp10 + tmp13;
    tmp3 = tmp10 - tmp13;
    tmp1 = tmp11 + tmp12;
    tmp2 = tmp11 - tmp12;

    // Odd part.
    let tmp4 = dequant(8 * 1 + x);
    let tmp5 = dequant(8 * 3 + x);
    let tmp6 = dequant(8 * 5 + x);
    let tmp7 = dequant(8 * 7 + x);

    const z13 = tmp6 + tmp5;  // Phase 6
    const z10 = tmp6 - tmp5;
    const z11 = tmp4 + tmp7;
    const z12 = tmp4 - tmp7;

    tmp7 = z11 + z13;  // Phase 5
    tmp11 = mul((z11 - z13), FIX_1_414213562);  // 2 * c4

    const z5 = mul((z10 + z12), FIX_1_847759065);  // 2 * c2
    tmp10 = mul(FIX_1_082392200, z12) - z5;  // 2 * (c2-c6)
    tmp12 = mul(-FIX_2_613125930, z10) + z5;

    tmp6 = tmp12 - tmp7;
    tmp5 = tmp11 - tmp6;
    tmp4 = tmp10 + tmp5;

    workspace[x + 8 * 0] = idescale(tmp0 + tmp7, END_PASS1_DESCALE_BITS);
    workspace[x + 8 * 7] = idescale(tmp0 - tmp7, END_PASS1_DESCALE_BITS);
    workspace[x + 8 * 1] = idescale(tmp1 + tmp6, END_PASS1_DESCALE_BITS);
    workspace[x + 8 * 6] = idescale(tmp1 - tmp6, END_PASS1_DESCALE_BITS);
    workspace[x + 8 * 2] = idescale(tmp2 + tmp5, END_PASS1_DESCALE_BITS);
    workspace[x + 8 * 5] = idescale(tmp2 - tmp5, END_PASS1_DESCALE_BITS);
    workspace[x + 8 * 4] = idescale(tmp3 + tmp4, END_PASS1_DESCALE_BITS);
    workspace[x + 8 * 3] = idescale(tmp3 - tmp4, END_PASS1_DESCALE_BITS);
}

// Rows; aka "Pass 2".
function aanIdctRow(scaledQuantTable, buf, workspace, y) {
    const wsptr = x => workspace[8 * y + x];
    const mul = fixedMul;

    // Even part.
    let tmp10 = wsptr(0) + wsptr(4);
    let tmp11 = wsptr(0) - wsptr(4);

    const tmp13 = wsptr(2) + wsptr(6);
    let tmp12 = mul((wsptr(2) - wsptr(6)), FIX_1_414213562) - tmp13;

    const tmp0 = tmp10 + tmp13;
    const tmp3 = tmp10 - tmp13;
    const tmp1 = tmp11 + tmp12;
    const tmp2 = tmp11 - tmp12;

    // Odd part.
    const z13 = wsptr(5) + wsptr(3);
    const z10 = wsptr(5) - wsptr(3);
    const z11 = wsptr(1) + wsptr(7);
    const z12 = wsptr(1) - wsptr(7);

    const tmp7 = z11 + z13;
    tmp11 = mul((z11 - z13), FIX_1_414213562);

    const z5 = mul((z10 + z12), FIX_1_847759065);  // 2 * c2
    tmp10 = mul(FIX_1_082392200, z12) - z5;  // 2 * (c2-c6)
    tmp12 = mul(-FIX_2_613125930, z10) + z5;

    const tmp6 = tmp12 - tmp7;
    const tmp5 = tmp11 - tmp6;
    const tmp4 = tmp10 + tmp5;

    const setOut = (x, val) => {
        // Shift right by PASS1_BITS bits to convert back to a normal int, and then by another 3 to divide by 8.
        val = idescale(val, PASS1_BITS + 3);
        val = rangeLimit(val);  // This also applies the +128 offset.
        buf[y * 8 + x] = val;
    };

    // Final output stage: scale down by a factor of 8 and range-limit
    setOut(0, tmp0 + tmp7);
    setOut(7, tmp0 - tmp7);
    setOut(1, tmp1 + tmp6);
    // The 2016 decoder had tmp0 here (a typo); libjpeg's jidctfst.c uses tmp1.
    setOut(6, tmp1 - tmp6);
    setOut(2, tmp2 + tmp5);
    setOut(5, tmp2 - tmp5);
    setOut(4, tmp3 + tmp4);
    setOut(3, tmp3 - tmp4);
}

// Uses the 16/16 integer representation that ATEN and libjpeg's jidctfst.c ("fast, not-so-accurate integer IDCT")
// do.  Note that, for performance, this routine *also* incorporates the dequantization step, which is why it takes
// scaledQuantTable as an argument.  (This argument does not actually contain "just" a scaled quant table; some
// constants have been pre-multiplied into it.  See the function that loads quant tables for more details.)
export function idctFixedAan(scaledQuantTable, buf, dstBuf) {
    // ATEN rounds things off early, at a cost to precision: the int32 values in 'workspace' are not scaled at all.
    const workspace = new Int32Array(64);

    for (let x = 0; x < 8; ++x) {
        aanIdctCol(scaledQuantTable, buf, workspace, x);
    }

    for (let y = 0; y < 8; ++y) {
        aanIdctRow(scaledQuantTable, dstBuf, workspace, y);
    }

    return dstBuf;
}
