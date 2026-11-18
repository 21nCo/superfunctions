#!/usr/bin/env bash
# Runs the BillFnStoreKit tests against StoreKit testing in the macOS host app.
#
# StoreKit testing reaches the host app through LaunchServices, which does not find an app under the temporary
# folder (/var/folders): there storekitagent fails every push for it (kLSApplicationNotFoundErr), so the app never
# sees Transaction.updates or a renewal and its transaction caches go stale. The derived data therefore goes under
# Xcode's DerivedData folder, and is removed afterwards unless BILLFN_STOREKIT_DERIVED_DATA names it (CI names one,
# which its runner discards).
#
# StoreKit testing keeps a simulated purchase error, Ask to Buy and finished transactions offered again between
# tests, so the tests that use them run in their own host processes. The other tests share one process.
set -euo pipefail

# Removes the derived data this script created, keeping the tests' exit status. StoreKit testing on macOS 26 writes
# the host app's receipt (Contents/_MASReceipt) so that this user cannot delete it, so a failed removal lifts the
# write protection it can and retries. Whatever is still left is listed with its owner, flags and ACL, and fails
# the script even when the tests passed.
remove_derived_data() {
  local status=$?
  rm -rf "$derived_data" 2>/dev/null && exit "$status"
  chflags -R nouchg "$derived_data" 2>/dev/null || true
  chmod -R -N "$derived_data" 2>/dev/null || true
  chmod -R u+w "$derived_data" 2>/dev/null || true
  rm -rf "$derived_data" 2>/dev/null && exit "$status"
  echo "Could not remove $derived_data as $(id -un) after the tests exited $status; left behind:" >&2
  find "$derived_data" ! -type d -exec ls -ldeO {} + >&2 || true
  exit 1
}

cd "$(dirname "$0")"
if [[ -n "${BILLFN_STOREKIT_DERIVED_DATA:-}" ]]; then
  derived_data="$BILLFN_STOREKIT_DERIVED_DATA"
else
  derived_data_root="$HOME/Library/Developer/Xcode/DerivedData"
  mkdir -p "$derived_data_root"
  derived_data="$(mktemp -d "$derived_data_root/BillFnStoreKitTesting.XXXXXX")"
  trap remove_derived_data EXIT
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
