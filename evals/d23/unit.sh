#!/usr/bin/env bash
# arms of one unit back to back; K first on even PR numbers
n=$1
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ $((n % 2)) = 0 ]; then $HERE/replay.sh $n K; $HERE/replay.sh $n P; else $HERE/replay.sh $n P; $HERE/replay.sh $n K; fi
