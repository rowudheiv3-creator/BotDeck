//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

var (
	shell32      = syscall.NewLazyDLL("shell32.dll")
	user32       = syscall.NewLazyDLL("user32.dll")
	pShellExec   = shell32.NewProc("ShellExecuteW")
	pMessageBoxW = user32.NewProc("MessageBoxW")
)

// openBrowser opens url in the person's default browser.
func openBrowser(url string) {
	verb, _ := syscall.UTF16PtrFromString("open")
	target, err := syscall.UTF16PtrFromString(url)
	if err != nil {
		return
	}
	pShellExec.Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(target)), 0, 0, 1)
}

func showError(msg string) {
	t, _ := syscall.UTF16PtrFromString(msg)
	c, _ := syscall.UTF16PtrFromString("BotDeck")
	pMessageBoxW.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), 0x10)
}
