//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
)

func openWindow(url string) error {
	if runtime.GOOS == "darwin" {
		return exec.Command("open", url).Start()
	}
	return exec.Command("xdg-open", url).Start()
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "noVNC-iKVM: "+format+"\n", args...)
	os.Exit(1)
}
