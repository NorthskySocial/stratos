FROM mcr.microsoft.com/playwright:v1.63.0-noble

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends libnss3-tools \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /runner \
  && npm install --prefix /runner --no-save playwright@1.63.0 \
  && chown -R pwuser:pwuser /runner

COPY --chown=pwuser:pwuser runtime/feedgen-ng-e2e-browser.mjs /runner/feedgen-ng-e2e-browser.mjs

USER pwuser
ENV NODE_EXTRA_CA_CERTS=/ca/root.crt
ENTRYPOINT ["node", "/runner/feedgen-ng-e2e-browser.mjs"]
