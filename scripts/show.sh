#!/usr/bin/env bash
# Print the public status summary from a local `wrangler dev`.
curl -s "http://127.0.0.1:8787/api/status.json?nocache=$RANDOM" -H 'Cache-Control: no-cache' | python3 -c "
import json,sys; d=json.load(sys.stdin)
print('OVERALL:', d['overall']['text'], '| stale:', d['stale'])
for c in d['components']: print('  %-11s %-15s %s' % (c['id'], c['status'], ('last confirmed: '+c['last_confirmed']['status']) if c.get('last_confirmed') else '; '.join(k['label']+': '+k['problem'] for k in c['checks'] if k.get('problem'))))
print('  active incidents:', [i['title'] for i in d['active_incidents']])"
