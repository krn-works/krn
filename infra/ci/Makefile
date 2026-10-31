.PHONY: build check

build:
	CGO_ENABLED=0 mise exec -- go build -trimpath -o bin/ci-platform ./cmd/ci-platform

check:
	mise exec -- go test -race ./...
	mise exec -- go vet ./...
