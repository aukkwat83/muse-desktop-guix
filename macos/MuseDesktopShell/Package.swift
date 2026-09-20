// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MuseDesktopShell",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "MuseDesktopShell", targets: ["MuseDesktopShell"])
    ],
    targets: [
        .executableTarget(
            name: "MuseDesktopShell",
            path: "Sources/MuseDesktopShell",
            resources: [
                .process("Resources")
            ]
        )
    ]
)
