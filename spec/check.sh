#!/bin/sh
# Model-check the gate invariants with TLC. Needs Java 11+.
set -eu
cd "$(dirname "$0")"
JAR=tla2tools.jar
VERSION=v1.8.0
if [ ! -f "$JAR" ]; then
  curl -fsSL -o "$JAR" "https://github.com/tlaplus/tlaplus/releases/download/$VERSION/tla2tools.jar"
fi
exec java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -workers auto -metadir states -config Sudare.cfg Sudare.tla
