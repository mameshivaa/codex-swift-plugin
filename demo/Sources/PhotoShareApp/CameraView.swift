import SwiftUI
import AVFoundation
import PhotosUI

/// Camera view for taking profile photos.
/// Bug layer 1: Missing NSCameraUsageDescription in Info.plist → runtime crash
/// Bug layer 2: Missing NSPhotoLibraryUsageDescription → runtime crash
/// Bug layer 3: Empty button action → UI does nothing
/// Bug layer 4: Unused @State → dead code
struct CameraView: View {
    @State private var session = AVCaptureSession()
    @State private var errorMessage: String = ""
    @State private var isLoading = false
    @State private var debugCounter = 0  // unused state

    var body: some View {
        VStack(spacing: 20) {
            // Camera preview placeholder
            Rectangle()
                .fill(Color.black)
                .frame(height: 400)
                .overlay(
                    Text("Camera Preview")
                        .foregroundColor(.white)
                )

            HStack(spacing: 40) {
                Button("Take Photo") {
                    // BUG: empty action — button does nothing
                }

                Button("Choose from Library") {
                    let library = PHPhotoLibrary.shared()
                    library.performChanges({}) { _, _ in }
                }
            }

            if !errorMessage.isEmpty {
                Text(errorMessage)
                    .foregroundColor(.red)
            }
        }
        .onAppear {
            let device = AVCaptureDevice.default(for: .video)
            guard let device else { return }
            do {
                let input = try AVCaptureDeviceInput(device: device)
                session.addInput(input)
                session.startRunning()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}
