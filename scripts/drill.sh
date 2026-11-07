#!/usr/bin/env bash
# Local outage drill: rehearses the brief's acceptance tests against scripts/fake-fasta.mjs.
# Needs: `node scripts/fake-fasta.mjs` and `npm run dev` running, with .dev.vars from docs/SETUP.md.
set -u
cd "$(dirname "$0")/.."
F=http://localhost:8790
A=http://127.0.0.1:8787/admin/api
H=(-H 'X-Requested-With: fasta-status' -H 'Content-Type: application/json')
tick() { for _ in $(seq 1 "${1:-1}"); do scripts/tick.sh; sleep 1; done; }
mode() { curl -s "$F/_mode?$1" >/dev/null; }
step() { echo; echo "=== $*"; }

mode "storefront=ok&api=ok&seller=ok"; tick 2

step "1. Stop the Laravel backend (API + seller login unreachable)"
mode "api=down&seller=down"
tick 1; echo "-- after 1 failed run (must NOT be an outage):"; scripts/show.sh
tick 2; echo "-- after 3 failed runs:"; scripts/show.sh
echo "-- private alerts received:"; curl -s $F/_alerts | python3 -c "import json,sys; [print(\"  ---\\n  \" + a.replace(chr(10), chr(10)+\"  \")) for a in json.load(sys.stdin)]"

step "2. Open a public incident while the 'Fasta admin panel' is down (status admin is independent)"
INC=$(curl -s "${H[@]}" -X POST $A/incidents -d '{"title":"Fasta app and seller dashboard unavailable","impact":"major_outage","components":["api","seller"],"message":"Some customers cannot load the Fasta app and sellers cannot sign in. We are investigating and will post another update by 3:30 p.m. EAT.","next_update_at":'$(( ($(date +%s)+1800)*1000 ))'}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "incident id $INC"; scripts/show.sh

step "3. Restore the backend: one success is not enough, two are"
mode "api=ok&seller=ok"
tick 1; echo "-- after 1 success:"; curl -s $A/overview -H 'X-Requested-With: fasta-status' | python3 -c "import json,sys; [print('  ', c['id'], c['state']['state']) for c in json.load(sys.stdin)['checks']]"
tick 1; echo "-- after 2 successes: checks recovered automatically..."; curl -s $A/overview -H 'X-Requested-With: fasta-status' | python3 -c "import json,sys; [print('  ', c['id'], c['state']['state']) for c in json.load(sys.stdin)['checks']]"
echo "-- ...but the public page keeps the operator's incident open until they verify and resolve:"; scripts/show.sh
curl -s "${H[@]}" -X POST $A/incidents/$INC/updates -d '{"stage":"monitoring","message":"A fix is in place. We are checking that sign-in and the app work for everyone."}' >/dev/null
curl -s "${H[@]}" -X POST $A/incidents/$INC/updates -d '{"stage":"resolved","message":"Resolved. Between 2:55 and 3:10 p.m. EAT the app and seller sign-in were unavailable. No action is needed."}' >/dev/null
echo "-- after operator resolves:"; scripts/show.sh

step "4. Break the storefront while Laravel stays up"
mode "storefront=maintenance"; tick 3; scripts/show.sh
mode "storefront=ok"; tick 2

step "5. HTTP 200 with unexpected content on /up, and an empty catalogue list"
mode "api=wrong"; tick 3; scripts/show.sh
curl -s $A/overview -H 'X-Requested-With: fasta-status' | python3 -c "import json,sys; [print('  ', c['id'], '->', c['state']['last_reason']) for c in json.load(sys.stdin)['checks'] if c['component'] in ('api','catalogue')]"
mode "api=empty"; tick 3
curl -s $A/overview -H 'X-Requested-With: fasta-status' | python3 -c "import json,sys; [print('  ', c['id'], '->', c['state']['last_reason']) for c in json.load(sys.stdin)['checks'] if c['component'] in ('api','catalogue')]"
mode "api=ok"; tick 2

step "6. Stop monitoring (no cron runs) until results are stale"
echo "(waiting 35s, STALE_AFTER_SECONDS=30 locally)"; sleep 35; scripts/show.sh
tick 1; echo "-- monitoring resumes:"; scripts/show.sh

step "7. Leak check: public JSON must not contain URLs of targets, reasons or secrets"
curl -s http://127.0.0.1:8787/api/status.json | grep -Eo 'localhost:8790|127\.0\.0\.1:8790|Application up|Timed out|Connection failed|hook|drill@' | sort -u | sed 's/^/  LEAK: /' || true
echo "  (no LEAK lines above = pass)"

step "8. Recovery alerts sent"
curl -s $F/_alerts | python3 -c "import json,sys; [print('  >', a.splitlines()[0]) for a in json.load(sys.stdin)]"
