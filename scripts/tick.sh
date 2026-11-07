#!/usr/bin/env bash
# Run one monitoring cycle against a local `wrangler dev` (simulates the per-minute cron).
curl -s -X POST "http://127.0.0.1:8787/cdn-cgi/local/explorer/api/local/scheduled?worker=fasta-status" \
  -H 'Content-Type: application/json' -d '{"cron":"* * * * *"}' >/dev/null
