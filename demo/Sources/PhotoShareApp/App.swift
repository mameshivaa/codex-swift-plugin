import SwiftUI

public struct PhotoShareApp: View {
    public init() {}

    public var body: some View {
        TabView {
            FeedView()
                .tabItem {
                    Label("Feed", systemImage: "photo.stack")
                }

            CameraView()
                .tabItem {
                    Label("Camera", systemImage: "camera")
                }

            ProfileView()
                .tabItem {
                    Label("Profile", systemImage: "person.circle")
                }
        }
    }
}
