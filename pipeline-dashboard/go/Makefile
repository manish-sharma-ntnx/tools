# MSP Pipeline Dashboard (Go) — build targets.
#
# The web UI assets live in webui/web and are embedded via go:embed, so the
# output is a single self-contained binary (no sibling public/ dir needed).

BINARY      := msp-pipeline-dashboard
PKG         := ./cmd/dashboard
DIST        := dist
VERSION     ?= $(shell git describe --tags --always 2>/dev/null || echo dev)
LDFLAGS     := -s -w -X main.version=$(VERSION)

.PHONY: all build run fmt vet test tidy clean dist package sync-web

all: build

## Sync the canonical UI assets from ../public into the embed dir.
sync-web:
	cp ../public/index.html ../public/styles.css ../public/app.js ../public/favicon.svg webui/web/

## Build the binary for the host platform.
build: sync-web
	go build -ldflags "$(LDFLAGS)" -o $(BINARY) $(PKG)

## Run locally (PORT/HOST/SLACK_* via env).
run: build
	./$(BINARY)

fmt:
	gofmt -w .

vet:
	go vet ./...

test:
	go test ./...

tidy:
	go mod tidy

clean:
	rm -f $(BINARY)
	rm -rf $(DIST)

## Cross-compile portable binaries for common targets.
dist: sync-web
	mkdir -p $(DIST)
	CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $(DIST)/$(BINARY)-linux-amd64   $(PKG)
	CGO_ENABLED=0 GOOS=linux   GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o $(DIST)/$(BINARY)-linux-arm64   $(PKG)
	CGO_ENABLED=0 GOOS=darwin  GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o $(DIST)/$(BINARY)-darwin-arm64  $(PKG)
	@echo "Built portable binaries in $(DIST)/"

## Build installable tarball(s) with the systemd installer (dist/packages/*.tar.gz).
package:
	VERSION=$(VERSION) ./packaging/make-package.sh
