// noVNC-iKVM launcher glue, used by both the connection form and the
// viewer page served by the launcher executable.

const params = new URLSearchParams(location.search);
const token = params.get("k") || "";

// Keep the launcher process alive while this window is open
function keepAlive() {
    const ws = new WebSocket(`ws://${location.host}/alive?k=${encodeURIComponent(token)}`);
    ws.onclose = () => setTimeout(keepAlive, 2000);
}
keepAlive();

const RECENT_KEY = "ikvm_recent";
const MAX_RECENT = 10;

function loadRecent() {
    try {
        const list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

function saveRecent(list) {
    try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
    } catch {
        // Storage may be unavailable; recents are a convenience only
    }
}

function viewerURL(host) {
    const path = `websockify?k=${encodeURIComponent(token)}&target=${encodeURIComponent(host)}`;
    const q = new URLSearchParams({
        k: token,
        autoconnect: "1",
        reconnect: "1",
        resize: "scale",
        title: host,
        path: path,
    });
    return "vnc.html?" + q.toString();
}

function connectForm() {
    const form = document.getElementById("connect");
    const host = document.getElementById("host");
    const user = document.getElementById("username");
    const pass = document.getElementById("password");
    const error = document.getElementById("error");

    const recent = loadRecent();

    const fill = (entry) => {
        host.value = entry.host;
        user.value = entry.username || "";
        pass.value = "";
        pass.focus();
    };

    const render = () => {
        const list = document.getElementById("recent-list");
        const datalist = document.getElementById("recent-hosts");
        list.replaceChildren();
        datalist.replaceChildren();
        document.getElementById("recent").hidden = recent.length === 0;
        recent.forEach((entry, i) => {
            const li = document.createElement("li");
            const a = document.createElement("a");
            a.href = "#";
            a.textContent = entry.host + " ";
            const u = document.createElement("span");
            u.className = "user";
            u.textContent = entry.username || "";
            a.append(u);
            a.addEventListener("click", (e) => { e.preventDefault(); fill(entry); });
            const forget = document.createElement("button");
            forget.type = "button";
            forget.className = "forget";
            forget.title = "Forget " + entry.host;
            forget.textContent = "×";
            forget.addEventListener("click", () => {
                recent.splice(i, 1);
                saveRecent(recent);
                render();
            });
            li.append(a, forget);
            list.append(li);
            const opt = document.createElement("option");
            opt.value = entry.host;
            datalist.append(opt);
        });
    };
    render();

    // Pick the username that goes with a remembered host
    host.addEventListener("change", () => {
        const entry = recent.find(e => e.host === host.value.trim());
        if (entry && entry.username) { user.value = entry.username; }
    });

    const preset = params.get("host");
    if (preset) {
        host.value = preset;
        const entry = recent.find(e => e.host === preset);
        if (entry && entry.username) { user.value = entry.username; }
        pass.focus();
    } else if (recent.length > 0) {
        fill(recent[0]);
    } else {
        host.focus();
    }

    form.addEventListener("submit", (e) => {
        e.preventDefault();
        const target = host.value.trim();
        if (!/^[A-Za-z0-9.\-:[\]_%]+$/.test(target)) {
            error.textContent = "That doesn't look like a host name or IP address.";
            host.focus();
            return;
        }
        error.textContent = "";

        const idx = recent.findIndex(r => r.host === target);
        if (idx !== -1) { recent.splice(idx, 1); }
        recent.unshift({ host: target, username: user.value });
        saveRecent(recent);

        // Handed to the viewer once, never put in the URL or stored
        sessionStorage.setItem("novnc_credentials",
                               JSON.stringify({ username: user.value, password: pass.value }));
        pass.value = "";
        location.href = viewerURL(target);
    });
}

// On the viewer page: a way back to the connection form
function viewerExtras() {
    const dlg = document.getElementById("noVNC_connect_dlg");
    if (!dlg) { return; }
    const back = document.createElement("a");
    back.href = "/?k=" + encodeURIComponent(token);
    back.textContent = "Connect to a different BMC";
    back.style.cssText = "display:block;margin-top:10px;color:white;text-align:center;font-size:14px;";
    dlg.querySelector("div") ? dlg.querySelector("div").append(back) : dlg.append(back);
}

if (document.getElementById("connect")) {
    connectForm();
} else {
    viewerExtras();
}
