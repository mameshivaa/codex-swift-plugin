import Testing
@testable import SwiftPMTestFail

@Test func addReturnsWrongExpectation() {
    #expect(Calculator.add(2, 3) == 6)
}

@Test func addReturnsSum() {
    #expect(Calculator.add(2, 3) == 5)
}
