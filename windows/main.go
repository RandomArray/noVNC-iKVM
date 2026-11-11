// noVNC-iKVM launcher: a single executable that serves the viewer and
// proxies the browser's WebSocket to a BMC's KVM port, then opens the
// viewer in an app window. Nothing to install.
//
// Licensed under MPL 2.0 (see LICENSE.txt)
package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Filled in at build time with -ldflags "-X main.version=..."
var version = "dev"

//go:embed web
var webFiles embed.FS

//go:embed launcher.html launcher.js
var launcherFiles embed.FS

const defaultKVMPort = "5900"

type server struct {
	token  string // per-run secret, required for the proxy
	origin string // http://127.0.0.1:<port>
	web    http.Handler

	mu      sync.Mutex
	pages   int       // open viewer/launcher windows
	lastBye time.Time // when the last window closed
	seen    bool      // a window has connected at least once
}

func main() {
	target := flag.String("host", "", "BMC address (host or host:port) to open straight away")
	noBrowser := flag.Bool("no-browser", false, "don't open a window, just print the URL")
	port := flag.Int("port", 0, "local port to use (default: any free port)")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println("noVNC-iKVM", version)
		return
	}
	if *target == "" && flag.NArg() > 0 {
		*target = flag.Arg(0)
	}

	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(*port)))
	if err != nil {
		fatal("Could not start the local web server: %v", err)
	}

	s := &server{token: randomToken(), origin: "http://" + ln.Addr().String()}
	sub, _ := fs.Sub(webFiles, "web")
	s.web = http.FileServer(http.FS(sub))

	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRoot)
	mux.HandleFunc("/websockify", s.handleProxy)
	mux.HandleFunc("/alive", s.handleAlive)

	startURL := s.origin + "/?k=" + s.token
	if *target != "" {
		startURL += "&host=" + url.QueryEscape(*target)
	}

	go s.exitWhenUnused()

	if *noBrowser {
		fmt.Println(startURL)
	} else if err := openWindow(startURL); err != nil {
		fatal("Could not open a browser window: %v\n\nOpen this address yourself:\n%s", err, startURL)
	}

	srv := &http.Server{Handler: s.guard(mux), ReadHeaderTimeout: 10 * time.Second}
	if err := srv.Serve(ln); err != nil {
		fatal("Local web server stopped: %v", err)
	}
}

func randomToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func (s *server) validToken(r *http.Request) bool {
	k := r.URL.Query().Get("k")
	return subtle.ConstantTimeCompare([]byte(k), []byte(s.token)) == 1
}

// Only answer requests made to our own address (blocks DNS rebinding)
// and add some defensive headers.
func (s *server) guard(h http.Handler) http.Handler {
	host := strings.TrimPrefix(s.origin, "http://")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != host {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		h.ServeHTTP(w, r)
	})
}

func (s *server) handleRoot(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/":
		if !s.validToken(r) {
			http.Error(w, "This page only works from the window that noVNC-iKVM opened.", http.StatusForbidden)
			return
		}
		serveEmbedded(w, launcherFiles, "launcher.html", "text/html; charset=utf-8")
	case "/launcher.js":
		serveEmbedded(w, launcherFiles, "launcher.js", "text/javascript; charset=utf-8")
	case "/vnc.html":
		s.serveViewer(w)
	default:
		s.web.ServeHTTP(w, r)
	}
}

func serveEmbedded(w http.ResponseWriter, files embed.FS, name, ctype string) {
	data, err := files.ReadFile(name)
	if err != nil {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", ctype)
	w.Write(data)
}

// The viewer page, plus the launcher script that keeps us alive and
// offers a way back to the connection form
func (s *server) serveViewer(w http.ResponseWriter) {
	data, err := webFiles.ReadFile("web/vnc.html")
	if err != nil {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	page := strings.Replace(string(data), "</body>",
		`<script type="module" src="launcher.js"></script></body>`, 1)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	io.WriteString(w, page)
}

// Each open window keeps a WebSocket here. When the last one has been
// closed for a while, the program exits.
func (s *server) handleAlive(w http.ResponseWriter, r *http.Request) {
	if !s.validToken(r) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	c, err := websocket.Accept(w, r, nil) // same-origin only
	if err != nil {
		return
	}
	s.mu.Lock()
	s.pages++
	s.seen = true
	s.mu.Unlock()

	// Block until the page goes away
	ctx := c.CloseRead(context.Background())
	<-ctx.Done()

	s.mu.Lock()
	s.pages--
	s.lastBye = time.Now()
	s.mu.Unlock()
}

func (s *server) exitWhenUnused() {
	start := time.Now()
	for range time.Tick(time.Second) {
		s.mu.Lock()
		pages, seen, lastBye := s.pages, s.seen, s.lastBye
		s.mu.Unlock()
		switch {
		case !seen && time.Since(start) > 2*time.Minute:
			// The window never showed up
			os.Exit(0)
		case seen && pages == 0 && time.Since(lastBye) > 10*time.Second:
			// Long enough to survive page reloads and navigation
			os.Exit(0)
		}
	}
}

// WebSocket <-> TCP proxy to the BMC's KVM port
func (s *server) handleProxy(w http.ResponseWriter, r *http.Request) {
	if !s.validToken(r) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	target, err := normalizeTarget(r.URL.Query().Get("target"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Connect to the BMC first so failures show up as a failed WebSocket
	tcp, err := net.DialTimeout("tcp", target, 10*time.Second)
	if err != nil {
		log.Printf("connect %s: %v", target, err)
		http.Error(w, "Could not reach "+target+": "+err.Error(), http.StatusBadGateway)
		return
	}
	defer tcp.Close()

	c, err := websocket.Accept(w, r, nil) // same-origin only
	if err != nil {
		return
	}
	c.SetReadLimit(-1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ws := websocket.NetConn(ctx, c, websocket.MessageBinary)
	defer ws.Close()

	done := make(chan struct{}, 2)
	go func() { io.Copy(tcp, ws); done <- struct{}{} }()
	go func() { io.Copy(ws, tcp); done <- struct{}{} }()
	<-done
}

func normalizeTarget(t string) (string, error) {
	t = strings.TrimSpace(t)
	if t == "" {
		return "", errors.New("no BMC address given")
	}
	host, port, err := net.SplitHostPort(t)
	if err != nil {
		// No port, or a bare IPv6 address
		host, port = strings.Trim(t, "[]"), defaultKVMPort
	}
	if host == "" || strings.ContainsAny(host, " /\\?#@") {
		return "", fmt.Errorf("invalid BMC address %q", t)
	}
	if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
		return "", fmt.Errorf("invalid port in %q", t)
	}
	return net.JoinHostPort(host, port), nil
}
