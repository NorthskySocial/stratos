FROM atmosbox-tools:local

USER root
COPY stacks/feedgen-ng-local/feedgen-identity.mjs /app/feedgen-identity.mjs
RUN chmod 0444 /app/feedgen-identity.mjs
