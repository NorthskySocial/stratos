# syntax=docker/dockerfile:1.7
# Build from the workspace root:
# docker build -f stratos-feedgen-ng/Dockerfile -t stratos-feedgen-ng:rehearsal .

FROM rust:1.94.1-bookworm@sha256:6ae102bdbf528294bc79ad6e1fae682f6f7c2a6e6621506ba959f9685b308a55 AS builder

WORKDIR /workspace
ENV RUSTUP_TOOLCHAIN=1.94.1

COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY stratos-feedgen-ng/ ./stratos-feedgen-ng/

# SQLCipher is compiled from the locked bundled source; no system cipher is
# selected at build or runtime.
RUN cargo build --locked --release --package stratos-feedgen-ng

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS runtime

COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

RUN rm --force /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' \
        'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20260918T000000Z bookworm main' \
        > /etc/apt/sources.list \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install --yes --no-install-recommends libssl3=3.0.20-1~deb12u2 \
    && rm --recursive --force /var/lib/apt/lists/*

COPY --from=builder /workspace/target/release/stratos-feedgen-ng /usr/local/bin/stratos-feedgen-ng

RUN mkdir --mode=0700 --parents /var/lib/feedgen /etc/feedgen \
    && chown 65532:65532 /var/lib/feedgen /etc/feedgen \
    && chmod 0555 /usr/local/bin/stratos-feedgen-ng

USER 65532:65532
WORKDIR /var/lib/feedgen

ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    RUST_BACKTRACE=0 \
    TMPDIR=/tmp

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/stratos-feedgen-ng"]
