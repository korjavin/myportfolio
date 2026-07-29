# myportfolio — one static binary, the whole PWA embedded, nothing else.
#
# CGO_ENABLED=0 is not an optimisation here, it is the shipping contract: the
# SQLite driver is pure Go (modernc.org/sqlite) and the PWA is go:embed'ed, so
# the result has no runtime dependencies at all and the final stage can be
# scratch. CI asserts the same thing (.github/workflows/ci.yml builds
# ./cmd/... with CGO_ENABLED=0); if that ever stops holding, this image stops
# being buildable rather than silently growing a libc.

FROM golang:1.26-alpine AS build
WORKDIR /src

# Dependencies first so an app-only change reuses the module cache layer.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
        -o /out/myportfolio ./cmd/myportfolio

# Staged here rather than in the final stage because scratch has no shell to
# run mkdir with.
RUN mkdir -p /out/data /out/tmp

FROM scratch

# The server makes no outbound calls today. The opt-in quote proxy
# (ARCHITECTURE.md 7) will, and on scratch its first HTTPS request would fail
# x509 with no hint why. One layer, ~200KB, buys that out.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

# --chown is required, not cosmetic: COPY --from resets ownership to root
# regardless of what the source stage set, and Docker seeds a fresh named
# volume from the image directory it is mounted over, ownership included. Get
# this wrong and the container crash-loops on "unable to open database file"
# the first time it meets an empty volume. (Observed, not theorised.)
COPY --from=build --chown=65532:65532 /out/data /data
COPY --from=build --chown=65532:65532 /out/tmp /tmp
COPY --from=build /out/myportfolio /myportfolio

# Numeric, because scratch has no /etc/passwd to resolve a name against.
USER 65532:65532

# The database lives on the mounted volume, not in the container's layer. The
# session secret is a row inside that same file (cmd/myportfolio/main.go), so
# one volume covers both — see docs/DEPLOY.md.
ENV MYPORTFOLIO_ADDR=:8080 \
    MYPORTFOLIO_DB=/data/myportfolio.db

EXPOSE 8080

# No HEALTHCHECK: scratch has no shell and no curl to run one with. /healthz
# and /readyz are probed from the edge instead — compose.yaml points Traefik's
# load-balancer health check at /readyz.
ENTRYPOINT ["/myportfolio"]
