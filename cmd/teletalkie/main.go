package main

import (
	"flag"
	"fmt"
	"log"
	"net"

	"teletalkie/internal/room"
	"teletalkie/internal/server"
	"teletalkie/internal/tlsgen"
	"teletalkie/web"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	useTLS := flag.Bool("tls", false, "enable HTTPS with self-signed certificate (required for mobile camera access)")
	flag.Parse()

	hub := room.NewHub()
	srv := server.New(*addr, web.FS, hub)

	printAddresses(*addr, *useTLS)

	if *useTLS {
		cert, err := tlsgen.SelfSigned()
		if err != nil {
			log.Fatalf("failed to generate TLS certificate: %v", err)
		}
		log.Println("Generated self-signed TLS certificate")
		log.Println("⚠️  Accept the security warning in your browser to proceed")
		if err := srv.ListenAndServeTLS(cert); err != nil {
			log.Fatal(err)
		}
	} else {
		log.Println("⚠️  Camera/mic won't work on mobile over HTTP. Use --tls for HTTPS.")
		if err := srv.ListenAndServe(); err != nil {
			log.Fatal(err)
		}
	}
}

func printAddresses(addr string, tls bool) {
	scheme := "http"
	if tls {
		scheme = "https"
	}

	_, port, _ := net.SplitHostPort(addr)
	if port == "" {
		port = "8080"
	}

	fmt.Println()
	fmt.Println("  ╔══════════════════════════════════════╗")
	fmt.Println("  ║          📻 TeleTalkie               ║")
	fmt.Println("  ╠══════════════════════════════════════╣")
	fmt.Printf("  ║  Local:   %s://localhost:%-5s     ║\n", scheme, port)

	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			if ipNet, ok := a.(*net.IPNet); ok && !ipNet.IP.IsLoopback() && ipNet.IP.To4() != nil {
				ip := ipNet.IP.String()
				line := fmt.Sprintf("%s://%s:%s", scheme, ip, port)
				fmt.Printf("  ║  LAN:     %-28s║\n", line)
			}
		}
	}

	fmt.Println("  ╚══════════════════════════════════════╝")
	fmt.Println()
}
