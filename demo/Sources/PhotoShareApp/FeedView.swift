import SwiftUI

/// Main feed view.
/// Bug layer: @State var posts never written to → always shows empty state
/// Bug layer: NavigationLink to EmptyView destination
struct FeedView: View {
    @State private var posts: [String] = []
    @State private var isRefreshing = false
    @State private var selectedTab = 0  // unused — tabs controlled by TabView binding elsewhere

    var body: some View {
        NavigationStack {
            if posts.isEmpty {
                ContentUnavailableView(
                    "No Posts Yet",
                    systemImage: "photo.on.rectangle",
                    description: Text("Take a photo to get started")
                )
            } else {
                List(posts, id: \.self) { post in
                    NavigationLink(post) {
                        EmptyView()  // BUG: navigation goes nowhere
                    }
                }
            }
        }
    }
}
