import SwiftUI
import CoreLocation
import Contacts

/// Profile editing screen.
/// Bug layer 1: Missing NSLocationWhenInUseUsageDescription → runtime crash
/// Bug layer 2: Missing NSContactsUsageDescription → runtime crash
/// Bug layer 3: Image("avatar") without bundle: .module → nil in SPM package
/// Bug layer 4: .constant() binding → TextField is read-only, user can't type
struct ProfileView: View {
    @State private var name: String = "John Doe"
    @State private var bio: String = ""
    @State private var showLocationPicker = false
    let locationManager = CLLocationManager()
    let contactStore = CNContactStore()

    var body: some View {
        NavigationStack {
            Form {
                Section("Profile Photo") {
                    HStack {
                        Image("avatar")  // BUG: missing bundle: .module for SPM
                            .resizable()
                            .frame(width: 60, height: 60)
                            .clipShape(Circle())

                        NavigationLink("Change Photo") {
                            CameraView()
                        }
                    }
                }

                Section("Info") {
                    TextField("Name", text: $name)
                    TextField("Bio", text: .constant(bio))  // BUG: .constant makes it read-only
                }

                Section("Location") {
                    Button("Set Location") {
                        locationManager.requestWhenInUseAuthorization()
                        showLocationPicker = true
                    }
                }

                Section("Import from Contacts") {
                    Button("Import Contact Info") {
                        contactStore.requestAccess(for: .contacts) { granted, _ in
                            if granted {
                                // Import contact data
                            }
                        }
                    }
                }
            }
            .navigationTitle("Edit Profile")
        }
    }
}
