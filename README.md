## noVNC-iKVM: browser console for IPMI/BMC KVMs

A browser-based remote console for server BMCs whose KVM uses the
**ATEN iKVM** protocol: Supermicro X7–X10 boards and other ATEN-based
BMCs whose own console needs Java. It's built on
[noVNC](https://github.com/novnc/noVNC) 1.7 (see
[README.noVNC.md](README.noVNC.md)), so ordinary VNC servers still work too.

### Features

- **ATEN iKVM protocol**: login with the BMC's IPMI username and password,
  and both video encodings: *Hermon* (0x59, X7/X8/X9 boards) and *AST2100*
  (0x57, X10-era AST2400 BMCs).
- **Paste works.** Press **Ctrl+Shift+V** (or use the clipboard panel) and
  the text is typed on the remote keyboard, so it works in BIOS screens,
  installers and text consoles. Long pastes show progress and can be
  cancelled.
- **Full keyboard**: keys go to the server as USB HID usages, so every key
  works, including `: { } + ? | ~ "`, the right-hand modifiers, numpad,
  F13–F24 and international keys. Keys are released when the window loses
  focus, so none get stuck.
- **Screenshots**: the camera button saves a PNG; Shift+click copies it to
  the clipboard.
- **"No video signal"** notice while the host's display is off.
- **Self-healing connection**: if the BMC stops sending video, the viewer
  asks again, and reconnects automatically if the connection drops.
- **One launcher for many BMCs** (`ikvm.sh`).

### Quick start

Requirements: `python3` (with `venv`) and network access to the BMC's KVM
port (TCP 5900).

```
git clone -b ikvm https://github.com/RandomArray/noVNC-iKVM.git
cd noVNC-iKVM
./ikvm.sh 192.0.2.10
```

Open the URL it prints and log in with the BMC's IPMI username and
password. The first run installs websockify into `.venv/`.

For several BMCs, list them in a file and run one proxy for all of them:

```
cp bmcs.conf.example bmcs.conf     # name: host[:port] per line
./ikvm.sh -c bmcs.conf
```

The launcher prints one URL per BMC. By default it only listens on
127.0.0.1. Use `-a` to listen on all interfaces, but only on a trusted
management network: anyone who can reach the port can reach your BMCs.

### Windows: single executable

`noVNC-iKVM.exe` is a single file with the viewer built in. There's
nothing to install and no Python is needed. Double-click it and a window
opens asking for the BMC address, username and password. It uses Edge in
app mode, which every Windows 11 machine has. Recent BMCs are remembered
(not their passwords), and closing the window ends the program.

`noVNC-iKVM.exe 10.0.0.10` (or a shortcut with the address as an
argument) opens the form with the address already filled in.

It listens on 127.0.0.1 only. A random secret for each run stops web pages
or other users from using it as a proxy.

Build it on Linux, macOS or WSL with Go installed:

```
windows/build.sh        # writes windows/dist/noVNC-iKVM.exe (x64) and an ARM64 build
```

The executable isn't code-signed, so Windows SmartScreen warns the first
time it's run from a download or network share. Signing it with your
organisation's code-signing certificate (`signtool sign ...`) avoids that.

### URL parameters

On top of the usual noVNC parameters (`host`, `port`, `path`,
`autoconnect`, …):

| Parameter | Meaning |
|---|---|
| `username`, `password` | Log in without being asked. Note that the password ends up in browser history. |
| `password=user:pass` | Old noVNC-iKVM style, still accepted. |
| `paste_shortcut` | `ctrl+shift+v` (default), `ctrl+v` or `none` |
| `typing_delay` | Milliseconds between key events when pasting (default 8) |

### Copy and paste: what is and isn't possible

An IPMI KVM is a video feed plus an emulated USB keyboard and mouse. There's
no clipboard channel. So:

- **Paste (your computer → server)** works by typing the text on the
  emulated keyboard. Characters are typed as on a **US keyboard layout**,
  and characters a US keyboard can't type (e.g. `é`, `€`) are skipped and
  reported. If the remote OS uses another layout, set it to US while
  pasting.
- **Copy (server → your computer)** isn't possible, because the viewer
  only receives pictures. Use the screenshot button.

If characters get lost while pasting on a slow BMC, raise *Typing delay* in
the settings. On a Supermicro X9 BMC, 4 ms per key was still reliable;
the default is 8 ms.

### Troubleshooting

- **"Connection refused" / it won't reconnect**: the BMC's KVM service has
  stopped. Reset the BMC (web UI → *Maintenance → Unit Reset*, or
  `ipmitool -I lanplus -H <bmc> -U <user> -P <pass> mc reset cold`). The
  host keeps running. The viewer reconnects by itself once the BMC is back.
- **Black screen, no "No video signal" notice**: check the browser console
  (Settings → Advanced → Logging: info) for `ATEN iKVM` messages.
- **BMC web UI won't load over HTTPS**: old BMCs only speak outdated TLS.
  This viewer doesn't use the web UI.

### Development

```
npm install
npm install --no-save @eslint/js
npx eslint core app tests
CHROME_BIN=/path/to/chrome TEST_BROWSER_NAME=ChromeHeadless npm test
```

The ATEN code lives in `core/rfb.js` (look for `ATEN`),
`core/decoders/aten*.js`, `core/decoders/ast2100/` and
`core/input/hidcodes.js`, with tests in `tests/test.aten.js` and
`tests/test.ast2100.js`.

### Credits

- [noVNC](https://github.com/novnc/noVNC) and its authors
- Kevin Kelley and Alan Sharp: the original ATEN iKVM and AST2100 support
  for noVNC
- [GoCodeIT-Inc/noVNC-iKVM](https://github.com/GoCodeIT-Inc/noVNC-iKVM)
- [chicken-aten-ikvm](https://github.com/thefloweringash/chicken-aten-ikvm)
  for its protocol notes

Licensed under the MPL 2.0, like noVNC.
