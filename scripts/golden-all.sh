#!/bin/sh
# Compare au bit près le cœur Rust et la version TypeScript sur plusieurs graines, politiques et
# événements. Usage : scripts/golden-all.sh [jours]   (sorties dans /tmp/golden)
set -e
cd "$(dirname "$0")/.."
DAYS=${1:-2160}
OUT=/tmp/golden
mkdir -p $OUT
EV='{"150":"tempete","400":"mauvaise_recolte","700":"epidemie","900":"incendie"}'
run() { # nom graine politique événements
  ./sim-rs/target/release/golden "$DAYS" "$2" "$3" "$4" > $OUT/$1.rs.jsonl
  npx tsx scripts/golden.ts "$DAYS" "$2" "$3" "$4" > $OUT/$1.ts.jsonl
  printf '%-12s ' "$1"; node scripts/compare.mjs $OUT/$1.ts.jsonl $OUT/$1.rs.jsonl | head -4
}
run graine1 1 '{}' '{}' &
run graine2 2 '{}' "$EV" &
run politique 3 '{"secuRate":0,"insuranceMandatory":true,"carbonTax":1,"wealthTax":0.01,"fiscalRule":"freinDette","ubi":1,"surplusDays":60,"insuranceMinLossRatio":0.8,"premiumIncomeCap":0.1}' "$EV" &
run laisserfaire 4 '{"incomeTaxLow":0,"incomeTaxHigh":0,"vat":0,"pension":0,"socialAidAmount":0,"teachersPer1000":3,"fiscalRule":"equilibre","grainReserve":false,"indexation":false,"fishingQuota":150}' '{}' &
wait
