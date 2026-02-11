package web

import "embed"

//go:embed *.html *.js *.css *.json *.png *.svg *.wav
var FS embed.FS
