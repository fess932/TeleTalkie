package main

import (
	"flag"
	"log"

	"teletalkie/internal/room"
	"teletalkie/internal/server"
	"teletalkie/web"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	flag.Parse()

	hub := room.NewHub()
	srv := server.New(*addr, web.FS, hub)

	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}
