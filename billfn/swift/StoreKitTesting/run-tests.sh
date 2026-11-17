#!/usr/bin/env bash
# Runs the BillFnStoreKit tests against StoreKit testing in the macOS host app.
#
# StoreKit testing reaches the host app through LaunchServices, which does not find an app under the temporary
# folder (/var/folders): there storekitagent fails every push for it (kLSApplicationNotFoundErr), so the app never
# sees Transaction.updates or a renewal and its transaction caches go stale. The derived data therefore goes under
# Xcode's DerivedData folder, and is removed afterwards unless BILLFN_STOREKIT_DERIVED_DATA names it.
#
# StoreKit testing keeps a simulated purchase error, Ask to Buy and finished transactions offered again between
# tests, so the tests that use them run in their own host processes. The other tests share one process.
set -euo pipefail

cd "$(dirname "$0")"
if [[ -n "${BILLFN_STOREKIT_DERIVED_DATA:-}" ]]; then
  derived_data="$BILLFN_STOREKIT_DERIVED_DATA"
else
  derived_data_root="$HOME/Library/Developer/Xcode/DerivedData"
  mkdir -p "$derived_data_root"
  derived_data="$(mktemp -d "$derived_data_root/BillFnStoreKitTesting.XXXXXX")"
  trap 'rm -rf "$derived_data"' EXIT
fi
common=(-project BillFnStoreKitTesting.xcodeproj -scheme BillFnStoreKitTesting
  -destination "platform=macOS,arch=$(uname -m)" -derivedDataPath "$derived_data")
isolated=(
  BillFnStoreKitTests/BillFnStoreKitTests/testPendingPurchaseIsNotVerifiedAndKeepsItsCheckout
  BillFnStoreKitTests/BillFnStoreKitTests/testCancelledPurchaseIsNeitherVerifiedNorKept
  BillFnStoreKitTests/BillFnStoreKitTests/testCancelledSecondAttemptKeepsThePendingAttemptsCheckout
  BillFnStoreKitTests/BillFnStoreKitTests/testRefusedPurchaseDropsItsCheckoutAndAFailedOneKeepsIt
  BillFnStoreKitTests/BillFnStoreKitTests/testConfirmedPurchaseOfferedAgainLeavesALeftoverCheckoutOutstanding
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
