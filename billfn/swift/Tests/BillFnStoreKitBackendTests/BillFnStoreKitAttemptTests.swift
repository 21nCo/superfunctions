import Foundation
import Testing
@testable import BillFnStoreKit

/// `BillFnStoreKit.mayClaimOutstanding`, which decides whether a transaction may claim an outstanding checkout. With
/// `reasonIsPurchase` nil it takes the iOS 16 and macOS 13 branch (no `Transaction.reason`), which these tests run
/// on any host.
@Suite("BillFn StoreKit attempt discriminator")
struct BillFnStoreKitAttemptTests {
    private let savedAt = Date(timeIntervalSince1970: 1_800_000_000)
    private let month: TimeInterval = 30 * 24 * 60 * 60

    private func transaction(
        _ id: UInt64, original: UInt64 = 100, product: String = "pro.month", purchasedAfterSave offset: TimeInterval,
        expiresAfterSave expiry: TimeInterval? = nil, superseded: Bool = false
    ) -> BillFnStoreKitAttemptFacts {
        BillFnStoreKitAttemptFacts(
            id: id, originalId: original, productId: product, purchaseDate: savedAt.addingTimeInterval(offset),
            expirationDate: expiry.map { savedAt.addingTimeInterval($0) }, superseded: superseded
        )
    }

    private func mayClaim(_ candidate: BillFnStoreKitAttemptFacts, history: [BillFnStoreKitAttemptFacts]) -> Bool {
        BillFnStoreKit.mayClaimOutstanding(candidate, reasonIsPurchase: nil, savedAt: savedAt, history: history + [candidate])
    }

    @Test("A first purchase completed after its attempt started claims the checkout")
    func firstPurchaseClaims() {
        #expect(mayClaim(transaction(100, purchasedAfterSave: 60 * 60, expiresAfterSave: month), history: []))
    }

    @Test("An upgrade bought through its own checkout and completed while the app was stopped claims it")
    func interruptedUpgradeClaims() {
        // The user held pro.month (active when the attempt started); the attempt upgraded to pro.year, which keeps the
        // subscription's original id and, unlike a first purchase, has an id other than its original id.
        let held = transaction(100, product: "pro.month", purchasedAfterSave: -10 * 24 * 60 * 60, expiresAfterSave: 20 * 24 * 60 * 60, superseded: true)
        let upgrade = transaction(105, product: "pro.year", purchasedAfterSave: 60 * 60, expiresAfterSave: 12 * month)
        #expect(mayClaim(upgrade, history: [held]))
    }

    @Test("A resubscription after the subscription lapsed claims the checkout")
    func resubscriptionClaims() {
        let lapsed = transaction(100, purchasedAfterSave: -2 * month, expiresAfterSave: -month)
        #expect(mayClaim(transaction(110, purchasedAfterSave: 60, expiresAfterSave: month), history: [lapsed]))
    }

    @Test("A renewal of the entitlement held when the attempt started does not claim the checkout")
    func renewalOfHeldEntitlementDoesNotClaim() {
        let held = transaction(100, purchasedAfterSave: -20 * 24 * 60 * 60, expiresAfterSave: 10 * 24 * 60 * 60)
        let renewal = transaction(101, purchasedAfterSave: 10 * 24 * 60 * 60, expiresAfterSave: 40 * 24 * 60 * 60)
        #expect(!mayClaim(renewal, history: [held]))
    }

    @Test("A renewal of a purchase another attempt made after this one started does not claim the checkout")
    func renewalOfLaterPurchaseDoesNotClaim() {
        let bought = transaction(100, purchasedAfterSave: 60 * 60, expiresAfterSave: month)
        let renewal = transaction(101, purchasedAfterSave: month, expiresAfterSave: 2 * month)
        #expect(!mayClaim(renewal, history: [bought]))
    }

    @Test("A transaction purchased before its attempt started does not claim the checkout")
    func olderPurchaseDoesNotClaim() {
        #expect(!mayClaim(transaction(100, purchasedAfterSave: -60 * 60, expiresAfterSave: month), history: []))
        #expect(mayClaim(transaction(100, purchasedAfterSave: -10 * 60, expiresAfterSave: month), history: []))
    }

    @Test("StoreKit's reason decides where it is known")
    func reasonDecides() {
        let held = transaction(100, purchasedAfterSave: -20 * 24 * 60 * 60, expiresAfterSave: 10 * 24 * 60 * 60)
        let renewal = transaction(101, purchasedAfterSave: 10 * 24 * 60 * 60)
        #expect(BillFnStoreKit.mayClaimOutstanding(renewal, reasonIsPurchase: true, savedAt: savedAt, history: [held]))
        #expect(!BillFnStoreKit.mayClaimOutstanding(transaction(100, purchasedAfterSave: 60), reasonIsPurchase: false, savedAt: savedAt, history: []))
        #expect(!BillFnStoreKit.mayClaimOutstanding(transaction(100, purchasedAfterSave: -60 * 60), reasonIsPurchase: true, savedAt: savedAt, history: []))
    }
}
