//go:build !windows

package main

import (
	"fmt"
	"os"
)

func openBrowser(url string) { fmt.Fprintln(os.Stderr, url) }

func showError(msg string) { fmt.Fprintln(os.Stderr, msg) }
