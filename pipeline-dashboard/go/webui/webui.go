// Package webui embeds the dashboard's static web assets so the whole app ships
// as a single self-contained binary (no sibling public/ directory needed).
package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:web
var embedded embed.FS

// FS returns the web/ directory as a filesystem rooted at the asset files
// (i.e. "index.html", "styles.css", ... without the "web/" prefix).
func FS() fs.FS {
	sub, err := fs.Sub(embedded, "web")
	if err != nil {
		panic(err) // build-time guarantee: web/ is always embedded
	}
	return sub
}
