import RFB from '../core/rfb.js';
import Websock from '../core/websock.js';
import Display from '../core/display.js';
import AtenHermonDecoder, { rgb555ToRGBX } from '../core/decoders/atenhermon.js';
import { codeToHID, charToHID, keysymToHID, keyEventToHID } from '../core/input/hidcodes.js';
import KeyTable from '../core/input/keysym.js';

import FakeWebSocket from './fake.websocket.js';

function push16(arr, n) { arr.push((n >> 8) & 0xff, n & 0xff); }
function push32(arr, n) { arr.push((n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff); }
function pushStr(arr, s) { for (let i = 0; i < s.length; i++) arr.push(s.charCodeAt(i)); }

// RGB555 little endian pixel
function px(r, g, b) {
    const v = (r << 10) | (g << 5) | b;
    return [v & 0xff, v >> 8];
}

// ATEN rect prelude + Hermon header
function hermonData(type, segments, payload) {
    const data = [];
    push32(data, 0);                      // flags
    push32(data, payload.length + 10);    // length
    data.push(type, 0);
    push32(data, segments);
    push32(data, payload.length + 10);
    return data.concat(payload);
}

describe('ATEN iKVM support', function () {
    before(FakeWebSocket.replace);
    after(FakeWebSocket.restore);

    describe('USB HID key tables', function () {
        it('maps physical keys to HID usages', function () {
            expect(codeToHID['KeyA']).to.equal(0x04);
            expect(codeToHID['Digit0']).to.equal(0x27);
            expect(codeToHID['Enter']).to.equal(0x28);
            expect(codeToHID['F12']).to.equal(0x45);
            expect(codeToHID['NumpadEnter']).to.equal(0x58);
            expect(codeToHID['IntlBackslash']).to.equal(0x64);
            expect(codeToHID['ShiftRight']).to.equal(0xe5);
            expect(codeToHID['MetaLeft']).to.equal(0xe3);
        });

        it('types US layout characters with the right shift state', function () {
            expect(charToHID('a')).to.deep.equal({ hid: 0x04, shift: false });
            expect(charToHID('A')).to.deep.equal({ hid: 0x04, shift: true });
            expect(charToHID(':')).to.deep.equal({ hid: 0x33, shift: true });
            expect(charToHID('{')).to.deep.equal({ hid: 0x2f, shift: true });
            expect(charToHID('}')).to.deep.equal({ hid: 0x30, shift: true });
            expect(charToHID('+')).to.deep.equal({ hid: 0x2e, shift: true });
            expect(charToHID('?')).to.deep.equal({ hid: 0x38, shift: true });
            expect(charToHID('"')).to.deep.equal({ hid: 0x34, shift: true });
            expect(charToHID('\n')).to.deep.equal({ hid: 0x28, shift: false });
            expect(charToHID('\t')).to.deep.equal({ hid: 0x2b, shift: false });
            expect(charToHID('é')).to.be.null;
        });

        it('can type every printable ASCII character', function () {
            for (let c = 0x20; c < 0x7f; c++) {
                expect(charToHID(String.fromCharCode(c)), String.fromCharCode(c)).to.not.be.null;
            }
        });

        it('falls back to keysyms when there is no physical key', function () {
            expect(keysymToHID(KeyTable.XK_Escape)).to.equal(0x29);
            expect(keysymToHID(KeyTable.XK_F1)).to.equal(0x3a);
            expect(keysymToHID(KeyTable.XK_Control_R)).to.equal(0xe4);
            expect(keysymToHID(KeyTable.XK_KP_5)).to.equal(0x5d);
            expect(keysymToHID(0x7b /* { */)).to.equal(0x2f);
            expect(keyEventToHID(KeyTable.XK_a, 'KeyQ')).to.equal(0x14);  // AZERTY: physical key wins
            expect(keyEventToHID(KeyTable.XK_a, null)).to.equal(0x04);
            expect(keyEventToHID(0x20ac /* euro */, null)).to.be.null;
        });
    });

    describe('Hermon decoder', function () {
        let decoder, display;

        function decode(x, y, w, h, chunks) {
            const sock = new Websock();
            sock.open("ws://example.com");
            let done = false;
            sock.on('message', () => {
                done = decoder.decodeRect(x, y, w, h, sock, display, 24);
            });
            for (const chunk of chunks) {
                sock._websocket._receiveData(new Uint8Array(chunk));
            }
            display.flip();
            return done;
        }

        beforeEach(function () {
            decoder = new AtenHermonDecoder();
            display = new Display(document.createElement('canvas'));
            display.resize(32, 32);
        });

        it('converts RGB555 to RGBX', function () {
            const out = new Uint8Array(8);
            rgb555ToRGBX(new Uint8Array([...px(31, 0, 0), ...px(0, 16, 31)]), 0, out, 0, 2);
            expect(Array.from(out)).to.deep.equal([255, 0, 0, 255, 0, 132, 255, 255]);
        });

        it('decodes a raw frame', function () {
            const payload = [].concat(px(31, 0, 0), px(0, 31, 0), px(0, 0, 31), px(31, 31, 31));
            expect(decode(0, 0, 2, 2, [hermonData(1, 0x12345678, payload)])).to.be.true;
            const img = display.getImageData().data;
            expect(Array.from(img.slice(0, 8))).to.deep.equal([255, 0, 0, 255, 0, 255, 0, 255]);
            expect(Array.from(img.slice(32 * 4, 32 * 4 + 8))).to.deep.equal([0, 0, 255, 255, 255, 255, 255, 255]);
        });

        it('decodes 16x16 segments', function () {
            const payload = [0, 0, 0, 0, 1, 1];  // ?, ?, row 1, column 1
            for (let i = 0; i < 256; i++) payload.push(...px(0, 31, 0));
            expect(decode(0, 0, 32, 32, [hermonData(0, 1, payload)])).to.be.true;
            const img = display.getImageData().data;
            const at = (x, y) => Array.from(img.slice((y * 32 + x) * 4, (y * 32 + x) * 4 + 4));
            expect(at(16, 16)).to.deep.equal([0, 255, 0, 255]);
            expect(at(31, 31)).to.deep.equal([0, 255, 0, 255]);
            expect(at(15, 15)).to.not.deep.equal([0, 255, 0, 255]);
        });

        it('handles data split over several messages', function () {
            const payload = [];
            for (let i = 0; i < 4; i++) payload.push(...px(31, 0, 31));
            const all = hermonData(1, 0, payload);
            expect(decode(0, 0, 2, 2, [all.slice(0, 5), all.slice(5, 13), all.slice(13, 21), all.slice(21)])).to.be.true;
            expect(Array.from(display.getImageData().data.slice(0, 4))).to.deep.equal([255, 0, 255, 255]);
        });

        it('treats an empty segment update as done', function () {
            expect(decode(0, 0, 32, 32, [hermonData(0, 0, [])])).to.be.true;
        });

        it('rejects inconsistent lengths', function () {
            const data = hermonData(1, 0, [1, 2, 3, 4]);
            data[17] = 99;  // header length != prelude length
            const sock = new Websock();
            sock.open("ws://example.com");
            sock._websocket._receiveData(new Uint8Array(data));
            expect(() => decoder.decodeRect(0, 0, 1, 2, sock, display, 24)).to.throw(/mismatch/);
        });
    });

    describe('Protocol', function () {
        let clock, container, client;

        before(function () {
            clock = sinon.useFakeTimers(Date.now());
            window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
        });
        after(function () {
            clock.restore();
        });

        beforeEach(function () {
            container = document.createElement('div');
            document.body.appendChild(container);
            client = new RFB(container, 'ws://host:6080');
            clock.tick();
            client._sock._websocket._open();
        });
        afterEach(function () {
            client.disconnect();
            clock.tick(5000);
            document.body.removeChild(container);
        });

        const recv = data => client._sock._websocket._receiveData(new Uint8Array(data));
        const sent = () => Array.from(client._sock._websocket._getSentData());

        // Version + security list containing only Tight (16), as ATEN does
        function handshakeToAuth() {
            const ver = []; pushStr(ver, 'RFB 003.008\n'); recv(ver);
            sent();
            recv([1, 16]);
            expect(sent()).to.deep.equal([16]);
        }

        // 24 bytes as sent by an X9 (Hermon) board
        const atenBlob = [0xaf, 0xf9, 0x7f, 0xbe, 0xe8, 0x13, 0x02, 0x00, 0x30, 0xa4, 0x00, 0x00,
                          0x84, 0xec, 0xfd, 0xbe, 0x00, 0x40, 0x24, 0x40, 0x68, 0x24, 0x01, 0x00];

        function serverInit() {
            const data = [0, 0, 0, 0];  // SecurityResult OK
            push16(data, 480); push16(data, 640);
            data.push(32, 24, 0, 1); push16(data, 255); push16(data, 255); push16(data, 255);
            data.push(16, 8, 0, 0, 0, 0);
            push32(data, 16); pushStr(data, 'ATEN iKVM Server');
            data.push(0, 0, 0, 0, 0, 1, 0x80, 2, 1, 0, 1, 1);  // ATEN extension
            return data;
        }

        function connect() {
            client._rfbCredentials = { username: 'ADMIN', password: 'secret' };
            handshakeToAuth();
            recv(atenBlob);
            sent();
            recv(serverInit());
            expect(client._rfbConnectionState).to.equal('connected');
            sent();
        }

        it('detects an older ATEN BMC and asks for username and password', function () {
            const spy = sinon.spy();
            client.addEventListener('credentialsrequired', spy);
            handshakeToAuth();
            recv(atenBlob);
            expect(client.isAtenIKVM).to.be.true;
            expect(spy).to.have.been.calledOnce;
            expect(spy.args[0][0].detail.types).to.deep.equal(['username', 'password']);

            client.sendCredentials({ username: 'ADMIN', password: 'secret' });
            clock.tick();
            const out = sent();
            expect(out.length).to.equal(48);
            expect(String.fromCharCode(...out.slice(0, 5))).to.equal('ADMIN');
            expect(out.slice(5, 24).every(b => b === 0)).to.be.true;
            expect(String.fromCharCode(...out.slice(24, 30))).to.equal('secret');
            expect(client._rfbInitState).to.equal('SecurityResult');
        });

        it('detects a newer (AST2400) ATEN BMC', function () {
            client._rfbCredentials = { username: 'u', password: 'p' };
            handshakeToAuth();
            const blob = [0, 0, 0, 0, 0x01, 0x02, 0x01, 0x00].concat(new Array(16).fill(7));
            recv(blob);
            expect(client.isAtenIKVM).to.be.true;
            expect(sent().length).to.equal(48);
        });

        it('still treats real TightVNC servers as Tight', function () {
            handshakeToAuth();
            recv([0, 0, 0, 0]);
            expect(client.isAtenIKVM).to.be.false;
            expect(client._rfbTightVNC).to.be.true;
        });

        it('finishes the handshake and asks for video without SetPixelFormat', function () {
            client._rfbCredentials = { username: 'ADMIN', password: 'secret' };
            handshakeToAuth();
            recv(atenBlob);
            sent();
            recv(serverInit());
            expect(client._rfbConnectionState).to.equal('connected');
            const out = sent();
            expect(out[0]).to.equal(1);         // ClientInit (shared)
            expect(out[1]).to.equal(2);         // SetEncodings, not SetPixelFormat (0)
            const n = (out[3] << 8) | out[4];
            const encs = [];
            for (let i = 0; i < n; i++) {
                const o = 5 + i * 4;
                encs.push((out[o] << 24) | (out[o + 1] << 16) | (out[o + 2] << 8) | out[o + 3]);
            }
            expect(encs).to.include(0x59);
            expect(encs).to.include(0x57);
            const req = out.slice(5 + n * 4);
            expect(req).to.deep.equal([3, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]);
        });

        it('sends HID key events', function () {
            connect();
            client.sendKey(KeyTable.XK_a, 'KeyA', true);
            expect(sent()).to.deep.equal([4, 0, 1, 0, 0, 0, 0, 0, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            client.sendKey(KeyTable.XK_Shift_R, 'ShiftRight', false);
            expect(sent()).to.deep.equal([4, 0, 0, 0, 0, 0, 0, 0, 0xe5, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        });

        it('types characters from keys without a physical key code', function () {
            connect();
            client.sendKey(0x3a /* : */, null, true);
            const out = sent();
            expect(out.length).to.equal(4 * 18);
            expect([out[2], out[8]]).to.deep.equal([1, 0xe1]);     // shift down
            expect([out[20], out[26]]).to.deep.equal([1, 0x33]);   // ; down
            expect([out[56], out[62]]).to.deep.equal([0, 0xe1]);   // shift up
            client.sendKey(0x3a, null, false);
            expect(sent()).to.deep.equal([]);
        });

        it('sends pointer events in the ATEN format', function () {
            connect();
            client._sendMouse(300, 200, 1);
            expect(sent()).to.deep.equal([5, 0, 1, 0x01, 0x2c, 0x00, 0xc8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        });

        it('handles ATEN server messages', function () {
            connect();
            const spy = sinon.spy();
            client.addEventListener('atensession', spy);
            const msg = [57];
            push32(msg, 1); push32(msg, 1);
            const text = '65538 ADMIN ';
            pushStr(msg, text);
            msg.push(0xb5, 0x56, 0);
            while (msg.length < 265) msg.push(0x41);
            recv(msg.slice(0, 100));       // partial
            expect(spy).to.not.have.been.called;
            recv(msg.slice(100).concat([22, 0]).concat([51, 1, 2, 3, 4]));
            expect(spy).to.have.been.calledOnce;
            expect(spy.args[0][0].detail.text).to.equal('65538 ADMIN');
            expect(client._rfbConnectionState).to.equal('connected');
        });

        function fbu(w, h, enc, rectData) {
            const data = [0, 0];
            push16(data, 1);
            push16(data, 0); push16(data, 0); push16(data, w); push16(data, h);
            push32(data, enc);
            return data.concat(rectData);
        }

        it('resizes to the frame size and requests the next frame', function () {
            connect();
            const payload = [];
            for (let i = 0; i < 4 * 2; i++) payload.push(...px(1, 2, 3));
            recv(fbu(4, 2, 0x59, hermonData(1, 0, payload)));
            expect(client._fbWidth).to.equal(4);
            expect(client._fbHeight).to.equal(2);
            expect(sent()).to.deep.equal([3, 1, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]);
        });

        it('clears the screen and asks for a full frame when the video mode changes', function () {
            connect();
            const payload = [];
            for (let i = 0; i < 4 * 2; i++) payload.push(...px(31, 31, 31));
            recv(fbu(4, 2, 0x59, hermonData(1, 0, payload)));
            sent();
            // New mode, only a partial update (no tiles)
            recv(fbu(6, 3, 0x59, hermonData(0, 0, [])));
            expect(client._fbWidth).to.equal(6);
            client._display.flip();
            const img = client._display.getImageData().data;
            expect(Array.from(img.slice(0, 4))).to.deep.equal([0, 0, 0, 255]);
            // Next request is not incremental, then back to incremental
            expect(sent()).to.deep.equal([3, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]);
            recv(fbu(6, 3, 0x59, hermonData(0, 0, [])));
            expect(sent()).to.deep.equal([3, 1, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]);
        });

        it('asks for a full frame when the video signal comes back', function () {
            connect();
            recv(fbu(4, 2, 0x59, hermonData(0, 0, [])));
            sent();
            recv(fbu(64896, 65056, 0x59, []));
            clock.tick(600);
            sent();
            recv(fbu(4, 2, 0x59, hermonData(0, 0, [])));
            expect(sent()).to.deep.equal([3, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]);
        });

        it('refreshes the whole screen on request', function () {
            connect();
            recv(fbu(4, 2, 0x59, hermonData(0, 0, [])));
            sent();
            client.refreshScreen();
            recv(fbu(4, 2, 0x59, hermonData(0, 0, [])));
            expect(sent()).to.deep.equal([3, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]);
        });

        it('treats encoding 0 as the previous ATEN encoding', function () {
            connect();
            recv(fbu(4, 2, 0, [0, 0, 0, 0, 0, 0, 0, 0]));
            expect(client._rfbConnectionState).to.equal('connected');
            expect(sent()).to.deep.equal([3, 1, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]);
        });

        describe('screen off', function () {
            const OFF_W = 64896, OFF_H = 65056;
            let spy;
            beforeEach(function () {
                connect();
                spy = sinon.spy();
                client.addEventListener('videosignal', spy);
            });

            it('handles a header with nothing after it', function () {
                recv(fbu(OFF_W, OFF_H, 0x59, []));
                // Waits a moment to see whether any data follows
                expect(spy).to.not.have.been.called;
                clock.tick(100);
                expect(spy).to.have.been.calledOnce;
                expect(spy.args[0][0].detail.present).to.be.false;
                // Backs off before asking again
                expect(sent()).to.deep.equal([]);
                clock.tick(500);
                expect(sent()).to.deep.equal([3, 1, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]);
            });

            it('handles a header followed by an empty prelude', function () {
                recv(fbu(OFF_W, OFF_H, 0x59, [0, 0, 0, 0, 0, 0, 0, 0]).concat([22, 0]));
                expect(spy).to.have.been.calledOnce;
                expect(client._rfbConnectionState).to.equal('connected');
            });

            it('handles a header followed by a prelude and empty Hermon header', function () {
                recv(fbu(OFF_W, OFF_H, 0x59, hermonData(0, 0, [])).concat([22, 0]));
                expect(spy).to.have.been.calledOnce;
                expect(client._rfbConnectionState).to.equal('connected');
            });

            it('reports the signal coming back', function () {
                recv(fbu(OFF_W, OFF_H, 0x59, []));
                clock.tick(600);
                recv(fbu(4, 2, 0x59, hermonData(0, 0, [])));
                expect(spy).to.have.been.calledTwice;
                expect(spy.args[1][0].detail.present).to.be.true;
            });
        });

        it('re-requests video when the BMC goes quiet, then gives up', function () {
            connect();
            clock.tick(RFB.atenWatchdogTimeout);
            expect(sent()).to.deep.equal([3, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]);
            clock.tick(RFB.atenWatchdogTimeout * 3);
            expect(client._rfbConnectionState).to.not.equal('connected');
        });

        describe('typing text', function () {
            function keys(out) {
                const res = [];
                for (let i = 0; i < out.length; i += 18) {
                    res.push((out[i + 2] ? '+' : '-') + out[i + 8].toString(16));
                }
                return res;
            }

            it('types text with paced key events, holding shift across runs', async function () {
                connect();
                client.typingDelay = 10;
                const p = client.typeText('aB{\n');
                clock.tick(1000);
                const res = await p;
                expect(res).to.deep.equal({ typed: 4, skipped: 0, cancelled: false });
                expect(keys(sent())).to.deep.equal([
                    '+4', '-4',
                    '+e1', '+5', '-5', '+2f', '-2f',
                    '-e1', '+28', '-28',
                ]);
            });

            it('sends one key event per delay period', function () {
                connect();
                client.typingDelay = 10;
                client.typeText('abc');
                expect(sent().length).to.equal(18);
                clock.tick(10);
                expect(sent().length).to.equal(18);
                clock.tick(30);
                expect(sent().length).to.equal(18 * 3);
            });

            it('skips characters it cannot type', async function () {
                connect();
                const p = client.typeText('a€b');
                clock.tick(1000);
                expect(await p).to.deep.equal({ typed: 2, skipped: 1, cancelled: false });
            });

            it('releases shift when cancelled', async function () {
                connect();
                client.typingDelay = 10;
                const p = client.typeText('ABCDEF');
                clock.tick(25);
                sent();
                client.cancelTyping();
                const res = await p;
                expect(res.cancelled).to.be.true;
                expect(keys(sent())).to.deep.equal(['-e1']);
                clock.tick(1000);
                expect(sent()).to.deep.equal([]);
            });

            it('reports progress', async function () {
                connect();
                const spy = sinon.spy();
                client.addEventListener('typing', spy);
                const p = client.typeText('x'.repeat(25));
                clock.tick(5000);
                await p;
                const details = spy.args.map(a => a[0].detail);
                expect(details[0]).to.deep.equal({ done: 0, total: 25, finished: false });
                expect(details.map(d => d.done)).to.include(20);
                expect(details[details.length - 1]).to.deep.equal({ done: 25, total: 25, finished: true });
            });
        });

        describe('paste shortcut', function () {
            const ev = opts => Object.assign({ code: 'KeyV', key: 'v', ctrlKey: false,
                                               metaKey: false, shiftKey: false, altKey: false }, opts);
            it('defaults to Ctrl+Shift+V', function () {
                expect(client._isPasteShortcut(ev({ ctrlKey: true, shiftKey: true }))).to.be.true;
                expect(client._isPasteShortcut(ev({ ctrlKey: true }))).to.be.false;
                expect(client._isPasteShortcut(ev({ metaKey: true, shiftKey: true }))).to.be.true;
            });
            it('can be Ctrl+V or off', function () {
                client.pasteShortcut = 'ctrl+v';
                expect(client._isPasteShortcut(ev({ ctrlKey: true }))).to.be.true;
                expect(client._isPasteShortcut(ev({ ctrlKey: true, shiftKey: true }))).to.be.false;
                client.pasteShortcut = 'none';
                expect(client._isPasteShortcut(ev({ ctrlKey: true }))).to.be.false;
                expect(() => { client.pasteShortcut = 'bogus'; }).to.throw();
            });
            it('types pasted text', function () {
                connect();
                const spy = sinon.spy(client, 'typeText');
                const e = new Event('paste', { cancelable: true });
                e.clipboardData = { getData: () => 'hi' };
                client._canvas.dispatchEvent(e);
                expect(spy).to.have.been.calledWith('hi');
                expect(e.defaultPrevented).to.be.true;
            });
        });
    });
});
