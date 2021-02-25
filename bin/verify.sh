#!/bin/bash

set -euo pipefail

# Usage
# ./bin/verify <path to addresses.json>
# Lib_ResolvedDelegateProxy won't work

# TODO: finish this
ADDRESSES=$(cat addrs.json)
KEYS=$(echo "$ADDRESSES" | jq -r '. | to_entries | .[].key')
ETHERSCAN_API_KEY=${ETHERSCAN_API_KEY}
INFURA_API_KEY=${INFURA_API_KEY}
COMPILER_VERSION=$(COMPILER_VERSION:-0.7.6)

mkdir -p build/solt

while read ADDRESS; do
    ADDRESS=$(echo $ADDRESS | cut -d ':' -f 1)
    FILE=$(find contracts/optimistic-ethereum -name $ADDRESS.sol)
    if [ -z $FILE ]; then
        echo "Missing $ADDRESS"
        continue
    fi
    solt write --npm --output build/solt/$ADDRESS.json $FILE
done <<< "$KEYS"

for FILE in build/solt/*.json; do
    KEY=$(echo $FILE | cut -d '/' -f3 | cut -d '.' -f1)
    ADDRESS=$(echo "$ADDRESSES" \
        | jq -r --arg key $KEY '.[$key]')

    solt verify \
        --network kovan \
        --etherscan $ETHERSCAN_API_KEY \
        --compiler $COMPILER_VERSION \
        --infura $INFURA_API_KEY \
        $FILE \
        $ADDRESS \
        $KEY
done
