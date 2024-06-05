FROM alpine:3.8
LABEL maintainer="Christophe Eymard christophe.eymard@gmail.com"

RUN apk add --no-cache borgbackup openssh

ENTRYPOINT ["/usr/bin/borg"]
