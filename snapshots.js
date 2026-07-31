name: snapshot-tick
on:
  schedule:
    - cron: "*/15 * * * *"   # every 15 min; endpoint decides internally if a snapshot is due
  workflow_dispatch: {}       # manual trigger button for testing

jobs:
  tick:
    runs-on: ubuntu-latest
    steps:
      - name: Hit snapshot tick endpoint
        run: |
          curl -sS -X POST "${{ secrets.SITE_URL }}/api/snapshot-tick" \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" \
            --fail-with-body
      - name: Hit draw tick endpoint
        run: |
          curl -sS -X POST "${{ secrets.SITE_URL }}/api/draw-tick" \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" \
            --fail-with-body
