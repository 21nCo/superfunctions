#!/usr/bin/env bash
# Runs the BillFnStoreKit tests against StoreKit testing in the macOS host app.
#
# StoreKit testing keeps state in the test process. After a simulated purchase error, an
# Ask to Buy request or a finished transaction offered again, a later purchase's finish() does
# not reach the test store, so the tests that do one run in their own host processes. The other tests share one process: in a fresh one,
# StoreKit testing did not show a forced renewal to the app in local runs.
set -euo pipefail

cd "$(dirname "$0")"
derived_data="${BILLFN_STOREKIT_DERIVED_DATA:-$(mktemp -d)}"
common=(-project BillFnStoreKitTesting.xcodeproj -scheme BillFnStoreKitTesting
  -destination "platform=macOS,arch=$(uname -m)" -derivedDataPath "$derived_data")
isolated=(
  BillFnStoreKitTests/BillFnStoreKitTests/testPendingPurchaseIsNotVerifiedAndKeepsItsCheckout
  BillFnStoreKitTests/BillFnStoreKitTests/testCancelledPurchaseIsNeitherVerifiedNorKept
  BillFnStoreKitTests/BillFnStoreKitTests/testCancelledSecondAttemptKeepsThePendingAttemptsCheckout
  BillFnStoreKitTests/BillFnStoreKitTests/testRefusedPurchaseDropsItsCheckoutAndAFailedOneKeepsIt
  BillFnStoreKitTests/BillFnStoreKitTests/testConfirmedPurchaseOfferedAgainLeavesALeftoverCheckoutOutstanding
)

# In CI the host app can become active, so the real Transaction.updates test must run rather than skip.
if [[ -n "${CI:-}" ]]; then
  export TEST_RUNNER_BILLFN_STOREKIT_REQUIRE_UPDATES=1
fi

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
