FROM alpine:3.8
LABEL maintainer="Christophe Eymard christophe.eymard@gmail.com"

RUN apk add --no-cache borgbackup

ENTRYPOINT ["/usr/bin/borg"]
