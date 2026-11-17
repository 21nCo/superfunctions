#!/usr/bin/env bash
# Runs the BillFnStoreKit tests against StoreKit testing in the macOS host app.
#
# StoreKit testing keeps state in the test process. After a simulated purchase error or an
# Ask to Buy request, a later purchase's finish() does not reach the test store, so those two
# tests run in their own host processes. The other tests share one process: in a fresh one,
# StoreKit testing did not show a forced renewal to the app in local runs.
set -euo pipefail

cd "$(dirname "$0")"
derived_data="${BILLFN_STOREKIT_DERIVED_DATA:-$(mktemp -d)}"
common=(-project BillFnStoreKitTesting.xcodeproj -scheme BillFnStoreKitTesting
  -destination "platform=macOS,arch=$(uname -m)" -derivedDataPath "$derived_data")
isolated=(
  BillFnStoreKitTests/BillFnStoreKitTests/testPendingPurchaseIsNotVerifiedAndKeepsItsCheckout
  BillFnStoreKitTests/BillFnStoreKitTests/testCancelledPurchaseIsNeitherVerifiedNorKept
)

xcodebuild build-for-testing "${common[@]}" -onlyUsePackageVersionsFromResolvedFile -quiet

status=0
skip=()
for test in "${isolated[@]}"; do
  skip+=(-skip-testing:"$test")
done
echo "=== BillFnStoreKitTests (shared process)"
xcodebuild test-without-building "${common[@]}" "${skip[@]}" || status=1
for test in "${isolated[@]}"; do
  echo "=== $test"
  xcodebuild test-without-building "${common[@]}" -only-testing:"$test" || status=1
done
exit "$status"
