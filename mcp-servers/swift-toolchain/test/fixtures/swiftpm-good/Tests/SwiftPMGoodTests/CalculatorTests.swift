import Testing
@testable import SwiftPMGood

@Test func addReturnsSum() {
    #expect(Calculator.add(2, 3) == 5)
}
