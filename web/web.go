package web

import "embed"

//go:embed *.html *.js *.css *.json *.png *.svg
var FS embed.FS
