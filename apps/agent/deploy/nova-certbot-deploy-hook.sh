#!/bin/sh
set -eu
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
if /usr/bin/systemctl is-active --quiet nova-agent.service; then
  /usr/bin/systemctl restart nova-agent.service
fi
