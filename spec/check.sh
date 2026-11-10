#!/bin/sh
# Model-check the gate invariants with TLC. Needs Java 11+.
# Each configuration explores one sub-machine with the others held at rest.
set -eu
cd "$(dirname "$0")"
JAR=tla2tools.jar
VERSION=v1.8.0
if [ ! -f "$JAR" ]; then
  curl -fsSL -o "$JAR" "https://github.com/tlaplus/tlaplus/releases/download/$VERSION/tla2tools.jar"
fi
for cfg in Sudare.inbox.cfg Sudare.gates.cfg Sudare.round.cfg Sudare.note.cfg; do
  echo "== $cfg"
  java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -workers auto -metadir "states/$cfg" -config "$cfg" Sudare.tla
done
