//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

// Open the viewer in an Edge app window (no tabs or address bar), with
// its own profile so it doesn't disturb the user's browser. Fall back
// to the default browser.
func openWindow(url string) error {
	var candidates []string
	for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"} {
		if dir := os.Getenv(env); dir != "" {
			candidates = append(candidates, filepath.Join(dir, "Microsoft", "Edge", "Application", "msedge.exe"))
		}
	}
	profile := filepath.Join(os.Getenv("LOCALAPPDATA"), "noVNC-iKVM", "EdgeProfile")
	for _, edge := range candidates {
		if _, err := os.Stat(edge); err == nil {
			cmd := exec.Command(edge,
				"--app="+url,
				"--user-data-dir="+profile,
				"--window-size=1200,880",
				"--no-first-run",
				"--no-default-browser-check")
			if err := cmd.Start(); err == nil {
				go cmd.Wait()
				return nil
			}
		}
	}
	return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}

// No console window (built with -H windowsgui), so show errors in a box
func fatal(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	user32 := syscall.NewLazyDLL("user32.dll")
	box := user32.NewProc("MessageBoxW")
	text, _ := syscall.UTF16PtrFromString(msg)
	title, _ := syscall.UTF16PtrFromString("noVNC-iKVM")
	const mbIconError = 0x10
	box.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), mbIconError)
	os.Exit(1)
}
