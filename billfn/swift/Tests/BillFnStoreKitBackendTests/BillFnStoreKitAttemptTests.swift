import Foundation
import Testing
@testable import BillFnStoreKit

/// `BillFnStoreKitTransactionFacts.mayClaimOutstanding(savedAt:)`, which decides whether a transaction may claim an outstanding checkout, and
/// `reasonIsPurchase(transactionJSON:)`, which gives it StoreKit's reason on iOS 16 and macOS 13.
@Suite("BillFn StoreKit attempt discriminator")
struct BillFnStoreKitAttemptTests {
    private let savedAt = Date(timeIntervalSince1970: 1_800_000_000)

    private func mayClaim(purchasedAfterSave offset: TimeInterval, reasonIsPurchase: Bool?) -> Bool {
        BillFnStoreKitTransactionFacts(
            transactionId: "101", productId: "pro.month", appAccountToken: nil,
            purchaseDate: savedAt.addingTimeInterval(offset), isPurchase: reasonIsPurchase
        ).mayClaimOutstanding(savedAt: savedAt)
    }

    private func signed(_ fields: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: fields)
    }

    @Test("A purchase completed after its attempt started claims the checkout")
    func purchaseClaims() {
        #expect(mayClaim(purchasedAfterSave: 60 * 60, reasonIsPurchase: true))
    }

    @Test("A purchase made before its attempt started claims it only within the clock tolerance")
    func olderPurchaseDoesNotClaim() {
        #expect(!mayClaim(purchasedAfterSave: -60 * 60, reasonIsPurchase: true))
        #expect(mayClaim(purchasedAfterSave: -10 * 60, reasonIsPurchase: true))
    }

    @Test("A renewal does not claim the checkout, nor does a transaction whose reason is unknown")
    func renewalAndUnknownReasonDoNotClaim() {
        #expect(!mayClaim(purchasedAfterSave: 60 * 60, reasonIsPurchase: false))
        #expect(!mayClaim(purchasedAfterSave: 60 * 60, reasonIsPurchase: nil))
    }

    /// On iOS 16 and macOS 13 a renewal that recovers from billing retry after the subscription lapsed, bought after
    /// another attempt saved its checkout, looks like a resubscription by its dates. Its signed reason says it renews.
    @Test("A billing-retry recovery renewal bought after the attempt started does not claim the checkout")
    func recoveryRenewalDoesNotClaim() throws {
        let recovery = try signed([
            "transactionId": "101", "originalTransactionId": "100", "productId": "pro.month",
            "purchaseDate": 1_800_003_600_000, "transactionReason": "RENEWAL",
        ])
        let reason = BillFnStoreKit.reasonIsPurchase(transactionJSON: recovery)
        #expect(reason == false)
        #expect(!mayClaim(purchasedAfterSave: 60 * 60, reasonIsPurchase: reason))
    }

    @Test("The signed transaction's reason is read, and is unknown when missing or unrecognised")
    func reasonFromSignedTransaction() throws {
        #expect(BillFnStoreKit.reasonIsPurchase(transactionJSON: try signed(["transactionReason": "PURCHASE"])) == true)
        #expect(BillFnStoreKit.reasonIsPurchase(transactionJSON: try signed(["transactionReason": "RENEWAL"])) == false)
        #expect(BillFnStoreKit.reasonIsPurchase(transactionJSON: try signed(["transactionId": "101"])) == nil)
        #expect(BillFnStoreKit.reasonIsPurchase(transactionJSON: try signed(["transactionReason": "OTHER"])) == nil)
        #expect(BillFnStoreKit.reasonIsPurchase(transactionJSON: Data("not json".utf8)) == nil)
    }
}
