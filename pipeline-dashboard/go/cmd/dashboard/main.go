// Command dashboard is the MSP Pipeline Dashboard server (Go port).
//
// It polls read-only Jenkins controllers, auto-discovers version pipelines,
// serves the embedded web UI + JSON API, and posts Slack digests on a
// timezone-aware schedule. Single self-contained binary (web assets embedded).
package main

import (
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"syscall"
	"time"

	"github.com/nutanix/msp-pipeline-dashboard/internal/config"
	"github.com/nutanix/msp-pipeline-dashboard/internal/httpapi"
	"github.com/nutanix/msp-pipeline-dashboard/internal/model"
	"github.com/nutanix/msp-pipeline-dashboard/internal/scheduler"
	"github.com/nutanix/msp-pipeline-dashboard/internal/slack"
	"github.com/nutanix/msp-pipeline-dashboard/internal/store"
	"github.com/nutanix/msp-pipeline-dashboard/webui"
)

// version is set at build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	log.SetFlags(0)
	log.Printf("[msp-dashboard] version %s", version)

	// Wire the failure-alert sender into the store (avoids an import cycle).
	store.SetAlertSender(func(a model.Alert) any { return slack.SendFailureAlert(a) })

	handler := httpapi.Handler(webui.FS())
	addr := net.JoinHostPort(config.Setting.Host, fmt.Sprintf("%d", config.Setting.Port))

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		if isAddrInUse(err) {
			log.Printf("[msp-dashboard] port %d is already in use.\n"+
				"  Another instance is likely running. Options:\n"+
				"    - Use a different port:  PORT=4318 <run command>\n"+
				"    - Or stop the existing listener:  fuser -k %d/tcp",
				config.Setting.Port, config.Setting.Port)
		} else {
			log.Printf("[msp-dashboard] server error: %v", err)
		}
		os.Exit(1)
	}

	httpapi.LogStartup()
	log.Printf("[msp-dashboard] assets: embedded (go:embed)")

	// Initial poll, then start the digest scheduler and the periodic poll loop.
	go func() {
		s := store.Poll(false)
		log.Printf("[msp-dashboard] initial poll done: %d pipelines, %d blocks", s.Stats.Total, len(s.VersionBlocks))
		scheduler.Start()

		ticker := time.NewTicker(config.Setting.PollInterval)
		defer ticker.Stop()
		for range ticker.C {
			func() {
				defer func() {
					if r := recover(); r != nil {
						log.Printf("[msp-dashboard] poll failed: %v", r)
					}
				}()
				store.Poll(false)
			}()
		}
	}()

	srv := &http.Server{Handler: handler}
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("[msp-dashboard] serve error: %v", err)
	}
}

func isAddrInUse(err error) bool {
	return err != nil && errors.Is(err, syscall.EADDRINUSE)
}
