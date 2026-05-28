public enum BrokenCalculator {
    public static func add(_ lhs: Int, _ rhs: Int) -> Int {
        lhs + missingValue
    }
}
