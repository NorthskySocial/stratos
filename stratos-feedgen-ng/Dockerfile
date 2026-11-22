# syntax=docker/dockerfile:1.7
# Build from the workspace root:
# docker build -f stratos-feedgen-ng/Dockerfile -t stratos-feedgen-ng:rehearsal .

FROM rust:1.100.0-bookworm@sha256:ade39a710ef85f3506cffcfec3e8a24ba090badef1dff2fb798f71d878833fea AS builder

WORKDIR /workspace
ENV RUSTUP_TOOLCHAIN=1.100.0

COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY stratos-feedgen-ng/ ./stratos-feedgen-ng/

# SQLCipher is compiled from the locked bundled source; no system cipher is
# selected at build or runtime.
RUN cargo build --locked --release --package stratos-feedgen-ng

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS runtime

COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

RUN rm --force /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' \
        'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20261120T000000Z bookworm main' \
        'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20261120T000000Z bookworm-security main' \
        > /etc/apt/sources.list \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install --yes --no-install-recommends libssl3=3.0.22-1~deb12u2 \
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
